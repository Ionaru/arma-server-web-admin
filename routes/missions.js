var async = require('async');
var express = require('express');
var multer = require('multer');
var path = require('path');

// multer 2 decodes filenames as latin1 by default; browsers send UTF-8
var upload = multer({defParamCharset: 'utf8', storage: multer.diskStorage({})});

module.exports = function (missionsManager) {
    var router = express.Router();

    router.get('/', function (req, res) {
        res.json(missionsManager.missions);
    });

    router.post('/', upload.array('missions', 64), function (req, res) {
        var missions = req.files.filter(function (file) {
            return path.extname(file.originalname) === '.pbo';
        });

        async.parallelLimit(
            missions.map(function (missionFile) {
                return function (next) {
                    missionsManager.handleUpload(missionFile, next);
                };
            }),
            8,
            function (err) {
                if (err) {
                    res.status(500).send(err);
                } else {
                    res.status(200).json({success: true});
                }
            }
        );
    });

    router.get('/:mission', function (req, res) {
        var filename = req.params.mission;

        // relative to the missions folder: keeps the name inside it, and a dot-directory above it no longer matters
        res.download(filename, decodeURI(filename), {root: missionsManager.missionsPath()});
    });

    router.delete('/:mission', function (req, res) {
        var filename = req.params.mission;

        missionsManager.delete(filename, function (err) {
            if (err) {
                res.status(500).send(err);
            } else {
                res.json({success: true});
            }
        });
    });

    router.post('/refresh', function (req, res) {
        missionsManager.updateMissions();
        res.status(204).send();
    });

    router.post('/workshop', function (req, res) {
        var id = req.body && req.body.id;

        if (!id) {
            return res.status(400).json({error: 'id is required'});
        }

        missionsManager.downloadSteamWorkshop(id, function (err) {
            if (err) {
                res.status(500).send(err);
            } else {
                res.json({success: true});
            }
        });
    });

    return router;
};
