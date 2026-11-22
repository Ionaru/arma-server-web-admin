var Backbone = require('backbone');

// Identified by `id`, not `name`: the panel lists several folders (each server's -profiles folder
// and its HC_<n> subfolders), and two of them can hold a file with the same name.
module.exports = Backbone.Model.extend({
    defaults: {
        name: '',
        formattedSize: '0 B',
        size: 0,
        servers: [],
        role: null
    }
});
