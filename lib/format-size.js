var filesize = require('filesize').filesize;

// Binary units with the JEDEC names ("KB", "MB"): keeps the display the panel had before filesize 11.
module.exports = function formatSize(bytes) {
    return filesize(bytes, {base: 2, standard: 'jedec'});
};
