(function () {
  var root = ReactDOM.createRoot(document.getElementById('root'));

  function App() {
    var state = React.useState(new Date());
    var now = state[0];
    var setNow = state[1];

    React.useEffect(function () {
      var timer = setInterval(function () { setNow(new Date()); }, 1000);
      return function () { clearInterval(timer); };
    }, []);

    var second = now.getSeconds();
    var metrics = [
      ['1280×720', 'HDMI framebuffer'],
      ['BGRX', 'pixel format'],
      ['React 18', 'rendered by Chromium']
    ];

    return React.createElement('main', { className: 'stage' },
      React.createElement('section', { className: 'card' },
        React.createElement('span', { className: 'pill' }, 'LIVE ON HC800 HDMI'),
        React.createElement('h1', null, 'Modern ', React.createElement('span', { className: 'accent' }, 'React'), ' → HC800'),
        React.createElement('p', { className: 'subtitle' },
          'This page is a normal React app. A host-side Chromium renderer captures it and streams raw frames to /dev/fb0 through the kiosk API.'
        ),
        React.createElement('div', { className: 'metric-grid' }, metrics.map(function (metric) {
          return React.createElement('div', { className: 'metric', key: metric[1] },
            React.createElement('b', null, metric[0]),
            React.createElement('span', null, metric[1])
          );
        }))
      ),
      React.createElement('aside', { className: 'card side' },
        React.createElement('div', null,
          React.createElement('div', { className: 'clock' }, now.toLocaleTimeString()),
          React.createElement('p', { className: 'subtitle' }, 'Frame source: Playwright screenshot → BGRX → /api/frame')
        ),
        React.createElement('div', { className: 'bars' }, [0, 1, 2, 3, 4].map(function (i) {
          return React.createElement('div', { className: 'bar', key: i },
            React.createElement('i', { style: { width: ((second * 7 + i * 17) % 100) + '%' } })
          );
        }))
      )
    );
  }

  root.render(React.createElement(App));
}());