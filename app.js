var express = require('express');
var bodyParser = require('body-parser');
var morgan = require('morgan');
var path = require('path');
var serveStatic = require('serve-static');
var webpack = require('webpack');
var webpackMiddleware = require('webpack-dev-middleware');

var config = require('./config');
var webpackConfig = require('./webpack.config');
var setupBasicAuth = require('./lib/setup-basic-auth');
var Manager = require('./lib/manager');
var Missions = require('./lib/missions');
var Mods = require('./lib/mods');
var Logs = require('./lib/logs');
var OpMode = require('./lib/op-mode');
var Settings = require('./lib/settings');

var app = express();
var server = require('http').Server(app);
var io = require('socket.io')(server);

setupBasicAuth(config, app);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: false}));

morgan.token('user', function (req) {
    return req.auth ? req.auth.user : 'anon';
});
app.use(morgan(config.logFormat || 'dev'));

app.use(serveStatic(path.join(__dirname, 'public')));

var logs = new Logs(config);

var manager = new Manager(config, logs);
manager.load();

var missions = new Missions(config);
var mods = new Mods(config);
mods.updateMods();

var settings = new Settings(config);

var opMode = new OpMode(manager);

app.use('/api/logs', require('./routes/logs')(logs));
app.use('/api/missions', require('./routes/missions')(missions));
app.use('/api/mods', require('./routes/mods')(mods));
app.use('/api/op-mode', require('./routes/op-mode')(opMode));
app.use('/api/servers', require('./routes/servers')(manager, mods));
app.use('/api/settings', require('./routes/settings')(settings));

io.on('connection', function (socket) {
    socket.emit('missions', missions.missions);
    socket.emit('mods', mods.mods);
    socket.emit('op-mode', opMode.getState());
    socket.emit('servers', manager.getServers());
    socket.emit('settings', settings.getPublicSettings());
});

missions.on('missions', function (missions) {
    io.emit('missions', missions);
});

mods.on('mods', function (mods) {
    io.emit('mods', mods);
});

manager.on('servers', function () {
    io.emit('servers', manager.getServers());

    // A renamed or removed server can orphan the op server reference. refresh() only emits when
    // that actually changes, which matters because 'servers' also fires on every start and stop.
    opMode.refresh();
});

opMode.on('op-mode', function () {
    io.emit('op-mode', opMode.getState());
});

if (require.main === module) {
    // Only arm the schedule when actually running as the panel. The test suite requires this file,
    // and a scheduler that fired from a test run would stop every server on the box.
    opMode.load();

    var webpackCompiler = webpack(webpackConfig);

    app.use(webpackMiddleware(webpackCompiler, {
        publicPath: webpackConfig.output.publicPath
    }));

    server.listen(config.port, config.host);
}

module.exports = app;
