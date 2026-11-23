var fs = require('fs');

// Moves a file and refuses to overwrite an existing destination (the callback gets an Error).
module.exports = function moveFile(src, dst, cb) {
    fs.stat(dst, function (statErr) {
        if (!statErr) {
            return cb(new Error('File ' + dst + ' exists.'));
        }

        fs.rename(src, dst, function (renameErr) {
            if (!renameErr) {
                return cb(null);
            }

            // The rename can fail with EXDEV when src and dst are on different drives (the multer
            // temp folder and the missions folder), so fall back to copy and delete.
            fs.copyFile(src, dst, fs.constants.COPYFILE_EXCL, function (copyErr) {
                if (copyErr) {
                    return cb(copyErr);
                }

                fs.unlink(src, function (unlinkErr) {
                    cb(unlinkErr || null);
                });
            });
        });
    });
};
