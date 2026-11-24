require('bootstrap/dist/css/bootstrap.css');
require('bootstrap-icons/font/bootstrap-icons.css');
require('ladda/dist/ladda-themeless.min.css');
require('../css/styles.css');

require(['jquery', 'bootstrap/dist/js/bootstrap.bundle', 'backbone', 'app/router'], function ($, Bootstrap, Backbone, Router) {
    return new Router();
});
