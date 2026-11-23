require('bootstrap/dist/css/bootstrap.css');
require('ladda/dist/ladda-themeless.min.css');
require('../css/styles.css');

require(['jquery', 'bootstrap', 'backbone', 'app/router'], function ($, Bootstrap, Backbone, Router) {
    return new Router();
});
