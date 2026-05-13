/*
 * fake-vt-shim.c — LD_PRELOAD shim for NetSurf-FB on HC800 (inteldrmfb, i386)
 *
 * The HC800 runs inteldrmfb with no VT console (no /dev/tty0..N that respond
 * to VT/KD ioctls). NetSurf-FB (SDL fbcon backend) tries VT and KD ioctls
 * on startup and dies if they fail. This shim intercepts those ioctls and
 * returns success with safe values.
 *
 * It also patches SDL_SetVideoMode to strip SDL_FULLSCREEN, SDL_HWSURFACE and
 * SDL_DOUBLEBUF flags which would fail on inteldrmfb, and forces SDL_SWSURFACE.
 *
 * Compile on-device:
 *   gcc -shared -fPIC -O2 -o fake-vt-shim.so fake-vt-shim.c \
 *       -ldl -I/usr/include/SDL -D_GNU_SOURCE
 *
 * Usage:
 *   export LD_PRELOAD=/mnt/internal/browser/lib/fake-vt-shim.so
 *   export SDL_VIDEODRIVER=fbcon
 *   export SDL_FBDEV=/dev/fb0
 *   export HOME=/root
 *   /mnt/internal/browser/usr/bin/netsurf-fb "http://example.com"
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <dlfcn.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <linux/vt.h>
#include <linux/kd.h>
#include <linux/fb.h>

/* ── SDL types (minimal, avoids needing SDL headers at shim compile time) ─── */
typedef struct SDL_Surface_opaque SDL_Surface;
typedef unsigned int Uint32;
typedef unsigned short Uint16;
typedef unsigned char Uint8;

/* SDL surface struct layout (SDL 1.2.x) — only the fields we need */
struct sdl_surface_partial {
    Uint32  flags;          /* offset 0 */
    void   *format;         /* offset 4 */
    int     w, h;           /* offset 8, 12 */
    Uint16  pitch;          /* offset 16 */
    Uint8   _pad[2];        /* offset 18 */
    void   *pixels;         /* offset 20 */
};

/* SDL flags */
#define SDL_SWSURFACE   0x00000000
#define SDL_HWSURFACE   0x00000001
#define SDL_ASYNCBLIT   0x00000004
#define SDL_FULLSCREEN  0x80000000
#define SDL_DOUBLEBUF   0x40000000
#define SDL_HWPALETTE   0x20000000

/* ── Original function pointers ─────────────────────────────────────────── */
static int   (*real_ioctl)(int fd, unsigned long req, ...) = NULL;
static void *(*real_mmap)(void *addr, size_t len, int prot, int flags, int fd, off_t off) = NULL;
static int   (*real_open)(const char *path, int flags, ...) = NULL;
static SDL_Surface *(*real_SDL_SetVideoMode)(int w, int h, int bpp, Uint32 flags) = NULL;
static int   (*real_SDL_LockSurface)(SDL_Surface *s) = NULL;
static void  (*real_SDL_UnlockSurface)(SDL_Surface *s) = NULL;
static void  (*real_SDL_UpdateRect)(SDL_Surface *s, int x, int y, int w, int h) = NULL;

static void shim_init(void) __attribute__((constructor));

static void shim_init(void)
{
    real_ioctl           = dlsym(RTLD_NEXT, "ioctl");
    real_mmap            = dlsym(RTLD_NEXT, "mmap");
    real_open            = dlsym(RTLD_NEXT, "open");
    real_SDL_SetVideoMode= dlsym(RTLD_NEXT, "SDL_SetVideoMode");
    real_SDL_LockSurface = dlsym(RTLD_NEXT, "SDL_LockSurface");
    real_SDL_UnlockSurface=dlsym(RTLD_NEXT, "SDL_UnlockSurface");
    real_SDL_UpdateRect  = dlsym(RTLD_NEXT, "SDL_UpdateRect");
}

/* ── ioctl shim ──────────────────────────────────────────────────────────── */
int ioctl(int fd, unsigned long req, ...)
{
    va_list ap;
    void *arg;
    va_start(ap, req);
    arg = va_arg(ap, void *);
    va_end(ap);

    switch (req) {
    /* VT ioctls */
    case VT_OPENQRY: {
        int *vt = (int *)arg;
        if (vt) *vt = 1;
        fprintf(stderr, "[shim] VT_OPENQRY\n");
        return 0;
    }
    case VT_GETMODE: {
        struct vt_mode *vm = (struct vt_mode *)arg;
        if (vm) {
            vm->mode   = VT_AUTO;
            vm->waitv  = 0;
            vm->relsig = 0;
            vm->acqsig = 0;
        }
        return 0;
    }
    case VT_SETMODE:
        return 0;
    case VT_ACTIVATE:
        return 0;
    case VT_WAITACTIVE:
        return 0;
    case VT_RELDISP:
        return 0;

    /* KD ioctls */
    case KDSETMODE:
        return 0;
    case KDGKBMODE: {
        long *mode = (long *)arg;
        if (mode) *mode = K_UNICODE;
        return 0;
    }
    case KDSIGACCEPT:
        return 0;

    /* Framebuffer ioctls — pass through to real /dev/fb0 */
    case FBIOGET_VSCREENINFO:
    case FBIOGET_FSCREENINFO:
    case FBIOPAN_DISPLAY:
    case FBIO_WAITFORVSYNC:
        return real_ioctl(fd, req, arg);

    default:
        return real_ioctl(fd, req, arg);
    }
}

/* ── mmap shim (logging only) ───────────────────────────────────────────── */
void *mmap(void *addr, size_t len, int prot, int flags, int fd, off_t off)
{
    void *ret = real_mmap(addr, len, prot, flags, fd, off);
    fprintf(stderr, "[shim] mmap len=%u fd=%d -> %p\n",
            (unsigned)len, fd, ret);
    return ret;
}

/* ── open shim (logging only, non-dev/proc/sys paths) ──────────────────── */
int open(const char *path, int flags, ...)
{
    va_list ap;
    mode_t mode = 0;
    int ret;

    va_start(ap, flags);
    if (flags & O_CREAT)
        mode = va_arg(ap, int);
    va_end(ap);

    if (mode)
        ret = real_open(path, flags, mode);
    else
        ret = real_open(path, flags);

    if (path &&
        strncmp(path, "/dev/", 5) != 0 &&
        strncmp(path, "/proc/", 6) != 0 &&
        strncmp(path, "/sys/", 5) != 0) {
        fprintf(stderr, "[shim] open(%s) -> fd=%d\n", path, ret);
    }
    return ret;
}

/* ── SDL_SetVideoMode shim ──────────────────────────────────────────────── */
/*
 * Strip SDL_FULLSCREEN, SDL_HWSURFACE, and SDL_DOUBLEBUF — these all fail on
 * inteldrmfb because there's no actual VT/DRM flip support. Use SDL_SWSURFACE
 * so SDL allocates a software backing buffer and copies it on UpdateRect.
 */
SDL_Surface *SDL_SetVideoMode(int w, int h, int bpp, Uint32 flags)
{
    Uint32 new_flags = flags & ~(SDL_FULLSCREEN | SDL_HWSURFACE | SDL_DOUBLEBUF | SDL_HWPALETTE);
    new_flags |= SDL_SWSURFACE;

    fprintf(stderr, "[shim] SDL_SetVideoMode(%d,%d,%d,0x%08x) -> flags=0x%08x\n",
            w, h, bpp, flags, new_flags);

    SDL_Surface *s = real_SDL_SetVideoMode(w, h, bpp, new_flags);
    if (s) {
        struct sdl_surface_partial *sp = (struct sdl_surface_partial *)s;
        fprintf(stderr, "[shim] SDL surface: flags=0x%x pitch=%u pixels=%p\n",
                sp->flags, sp->pitch, sp->pixels);
    } else {
        fprintf(stderr, "[shim] SDL_SetVideoMode FAILED\n");
    }
    return s;
}

/* ── SDL_LockSurface / SDL_UnlockSurface shims (logging only) ───────────── */
int SDL_LockSurface(SDL_Surface *s)
{
    fprintf(stderr, "[shim] SDL_LockSurface\n");
    return real_SDL_LockSurface(s);
}

void SDL_UnlockSurface(SDL_Surface *s)
{
    fprintf(stderr, "[shim] SDL_UnlockSurface\n");
    real_SDL_UnlockSurface(s);
}

/* ── SDL_UpdateRect shim (diagnostic pixel dump) ────────────────────────── */
void SDL_UpdateRect(SDL_Surface *s, int x, int y, int w, int h)
{
    if (s) {
        struct sdl_surface_partial *sp = (struct sdl_surface_partial *)s;
        int stride_px = sp->pitch / 4;
        int sw = sp->w, sh = sp->h;
        unsigned int *pixels = (unsigned int *)sp->pixels;

        if (pixels && stride_px > 0) {
            int cx = (x + w / 2), cy = (y + h / 2);
            if (cx < 0) cx = 0;
            if (cy < 0) cy = 0;
            if (cx >= sw) cx = sw - 1;
            if (cy >= sh) cy = sh - 1;
            unsigned int mid_px = pixels[cy * stride_px + cx] & 0xFFFFFF;

            int nw = 0;
            int max_dump = 8;
            fprintf(stderr, "[shim] SDL_UpdateRect(%d,%d,%d,%d) stride=%d px@mid=0x%06x\n",
                    x, y, w, h, stride_px, mid_px);

            for (int py = y; py < y + h && py < sh && nw < max_dump * 2; py++) {
                for (int px2 = x; px2 < x + w && px2 < sw && nw < max_dump * 2; px2++) {
                    unsigned int c = pixels[py * stride_px + px2] & 0xFFFFFF;
                    if (c != 0xFFFFFF && c != 0x000000) {
                        if (nw < max_dump)
                            fprintf(stderr, "[shim] nw@(%u,%u)=0x%06x\n", px2, py, c);
                        nw++;
                    }
                }
            }
            if (nw > max_dump)
                fprintf(stderr, "[shim] SDL_UpdateRect(%d,%d,%d,%d) nonwhite/black=%d stride=%d px@mid=0x%06x\n",
                        x, y, w, h, nw, stride_px, mid_px);
        }
    }
    real_SDL_UpdateRect(s, x, y, w, h);
}
