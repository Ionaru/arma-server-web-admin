var express = require('express');

var Server = require('../lib/server');

function hasTitle(body) {
    return !!body && typeof body.title === 'string' && body.title.length > 0;
}

function hasIdChars(body) {
    return Server.idFromTitle(body.title) !== '';
}

module.exports = function (manager, mods) {
    var router = express.Router();

    router.get('/', function (req, res) {
        res.json(manager.getServers());
    });

    router.post('/', function (req, res) {
        if (!hasTitle(req.body)) {
            return res.status(400).json({error: 'title is required'});
        }

        if (!hasIdChars(req.body)) {
            return res.status(400).json({error: 'title must contain letters or digits'});
        }

        var server = manager.addServer(req.body);
        res.json(server);
    });

    router.get('/:server', function (req, res) {
        var server = manager.getServer(req.params.server);
        res.json(server);
    });

    router.put('/:server', function (req, res) {
        if (!hasTitle(req.body)) {
            return res.status(400).json({error: 'title is required'});
        }

        if (!hasIdChars(req.body)) {
            return res.status(400).json({error: 'title must contain letters or digits'});
        }

        var server = manager.getServer(req.params.server);
        server.update(req.body);
        manager.save();
        res.json(server);
    });

    router.delete('/:server', function (req, res) {
        var server = manager.removeServer(req.params.server);
        res.json(server);
    });

    router.post('/:server/start', function (req, res) {
        var server = manager.getServer(req.params.server);
        server.start();
        res.json({status: 'ok', pid: server.pid});
    });

    router.post('/:server/stop', function (req, res) {
        var server = manager.getServer(req.params.server);
        server.stop(function () {
            if (!server.pid) {
                res.json({status: true, pid: server.pid});
            } else {
                res.json({status: false, pid: server.pid});
            }
        });
    });

    return router;
};
