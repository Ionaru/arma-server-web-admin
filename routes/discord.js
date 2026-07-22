var express = require('express');

module.exports = function (discord) {
    var router = express.Router();

    // Posts a real message so an operator can confirm the token, channel id and bot permissions are
    // right before op night, rather than discovering a 401/403/404 when it matters.
    router.post('/test', function (req, res) {
        if (!discord.isConfigured()) {
            return res.status(400).json({error: 'Discord is not configured'});
        }

        discord.send('Test message from the Arma server panel.', function (err) {
            if (err) {
                return res.status(502).json({error: err.message});
            }

            res.json({ok: true});
        });
    });

    return router;
};
