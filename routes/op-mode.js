var express = require('express');

module.exports = function (opMode) {
    var router = express.Router();

    router.get('/', function (req, res) {
        res.json(opMode.getState());
    });

    router.put('/', function (req, res) {
        opMode.setConfig(req.body, function (err) {
            if (err) {
                return res.status(400).json({error: err.message});
            }

            res.json(opMode.getState());
        });
    });

    router.post('/run', function (req, res) {
        if (opMode.running) {
            return res.status(409).json({error: 'An op mode run is already in progress'});
        }

        var responded = false;

        opMode.run(function (err) {
            if (responded) {
                // The run was already under way when it failed, so the browser has its 202 and
                // will see the outcome over the socket.
                if (err) {
                    console.error('op-mode: run failed: ' + err.message);
                }

                return;
            }

            responded = true;

            // Every reason op mode refuses to run is raised synchronously, before anything is
            // stopped, so it can be reported straight back to whoever pressed the button.
            if (err) {
                return res.status(400).json({error: err.message});
            }

            res.json(opMode.getState());
        });

        if (!responded) {
            responded = true;

            // Stopping every server takes seconds and starting Arma takes considerably longer, so
            // do not hold the request open. The outcome reaches the browser over the socket, the
            // same way every other state change in this app does.
            res.status(202).json(opMode.getState());
        }
    });

    return router;
};
