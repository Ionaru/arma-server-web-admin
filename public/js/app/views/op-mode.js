var $ = require('jquery');
var _ = require('underscore');
var Marionette = require('marionette');
var sweetAlert = require('sweet-alert');

var tpl = require('tpl/op-mode.html');

var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

var errorText = function (err) {
    if (err && err.responseJSON && err.responseJSON.error) {
        return err.responseJSON.error;
    }

    if (err && err.responseText) {
        return err.responseText;
    }

    return 'An error occurred, please consult the logs';
};

module.exports = Marionette.ItemView.extend({
    template: _.template(tpl),

    modelEvents: {
        change: 'refresh'
    },

    initialize: function (options) {
        this.servers = options.servers;
        this.settings = options.settings;
        this.editing = false;

        // Only the things the server dropdown is built from. Listening to a plain 'change' would
        // re-render on every start and stop, since the servers collection carries live state.
        this.listenTo(this.servers, 'add remove change:title', this.refresh);

        // Re-render when Discord config availability changes, but not on unrelated settings churn.
        if (this.settings) {
            this.listenTo(this.settings, 'change:discordEnabled', this.refresh);
        }
    },

    events: {
        'click .save': 'save',
        'click .run': 'run',
        'click .test-discord': 'testDiscord',
        'change form': 'touched'
    },

    touched: function () {
        this.editing = true;
    },

    // State arrives over the socket whenever a run starts or finishes, or another admin saves.
    // Re-rendering then would silently throw away whatever this operator was in the middle of
    // typing, so hold off until their edits have been saved or abandoned.
    refresh: function () {
        if (this.editing) {
            return;
        }

        this.render();
    },

    templateHelpers: function () {
        var model = this.model;
        var settings = this.settings;

        return {
            dayNames: DAY_NAMES,
            servers: this.servers,
            discordEnabled: settings ? !!settings.get('discordEnabled') : false,

            isDaySelected: function (day) {
                return (model.get('days') || []).indexOf(day) !== -1 ? 'checked' : '';
            },

            isOpServer: function (id) {
                return model.get('opServerId') === id ? 'selected' : '';
            }
        };
    },

    serialize: function () {
        var days = [];

        this.$('form .day:checked').each(function () {
            days.push(parseInt($(this).val(), 10));
        });

        return {
            enabled: this.$('form .enabled').prop('checked'),
            days: days,
            time: this.$('form .time').val(),
            opServerId: this.$('form .op-server').val() || null
        };
    },

    save: function (event) {
        event.preventDefault();

        var self = this;
        var $save = this.$('.save');

        if ($save.prop('disabled')) {
            return;
        }

        $save.prop('disabled', true);

        this.model.save(this.serialize(), {
            wait: true,
            success: function () {
                // The form now matches the server, so socket pushes are free to re-render again.
                self.editing = false;
                self.render();

                sweetAlert({
                    title: 'Saved',
                    text: 'The op mode schedule has been saved.',
                    type: 'success'
                });
            },
            error: function (model, response) {
                // Leave editing set: the operator's input was rejected, not accepted, so it must
                // stay on screen for them to correct.
                $save.prop('disabled', false);

                sweetAlert({
                    title: 'Error',
                    text: errorText(response),
                    type: 'error'
                });
            }
        });
    },

    run: function (event) {
        event.preventDefault();

        var self = this;

        sweetAlert({
                title: 'Run op mode now?',
                text: 'Every server except the op server will be stopped immediately and players ' +
                    'will be disconnected. The op server will be restarted.',
                type: 'warning',
                showCancelButton: true,
                confirmButtonClass: 'btn-warning',
                confirmButtonText: 'Yes, run it!'
            },
            function () {
                self.model.run(function (err) {
                    if (err) {
                        sweetAlert({
                            title: 'Error',
                            text: errorText(err),
                            type: 'error'
                        });
                    }
                });
            });
    },

    testDiscord: function (event) {
        event.preventDefault();

        var $button = this.$('.test-discord');
        if ($button.prop('disabled')) {
            return;
        }

        $button.prop('disabled', true);

        $.ajax({
            url: '/api/discord/test',
            type: 'POST',
            success: function () {
                $button.prop('disabled', false);
                sweetAlert({
                    title: 'Sent',
                    text: 'A test message was posted to Discord.',
                    type: 'success'
                });
            },
            error: function (err) {
                $button.prop('disabled', false);
                sweetAlert({
                    title: 'Error',
                    text: errorText(err),
                    type: 'error'
                });
            }
        });
    }
});
