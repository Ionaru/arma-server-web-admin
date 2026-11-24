var _ = require('underscore');
var Marionette = require('marionette');
var bootstrap = require('bootstrap/dist/js/bootstrap.bundle');

var tpl = require('tpl/modal.html');

// The modal that is open right now, if any
var openModal = null;

// The only modal: a Bootstrap 5 modal around a content view. The content gets `ok`, `cancel`, `shown` and
// `hidden` events with this modal as the first argument. Bootstrap's events are native DOM events (jQuery
// is never put on `window`), so they are listened to with addEventListener.
module.exports = Marionette.View.extend({
    className: 'modal',

    attributes: {
        tabindex: '-1'
    },

    template: _.template(tpl),

    regions: {
        body: '.modal-body'
    },

    events: {
        'click .ok': 'okClicked'
    },

    templateContext: function () {
        return {
            okText: this.okText,
            cancelText: this.cancelText
        };
    },

    initialize: function (options) {
        this.content = options.content;
        this.okText = options.okText === undefined ? 'OK' : options.okText;
        this.cancelText = options.cancelText === undefined ? 'Cancel' : options.cancelText;
        this.animate = options.animate === true;
    },

    open: function () {
        var self = this;

        // One modal at a time: a second one would stack and break the focus traps and `modal-open`
        if (openModal && openModal !== this) {
            // The content is not in the region yet, so destroying the modal would not reach it
            this.content.destroy();
            this.destroy();
            return this;
        }
        openModal = this;

        this.render();
        this.showChildView('body', this.content);

        if (this.animate) {
            this.el.classList.add('fade');
        }

        this._previousFocus = document.activeElement;
        document.body.appendChild(this.el);

        this._shown = false;
        this._closing = false;
        this._closePending = false;
        this._bsModal = new bootstrap.Modal(this.el, {backdrop: true, keyboard: true, focus: true});

        // Bootstrap events bubble from nested components, only the modal's own count
        this.el.addEventListener('hide.bs.modal', function (event) {
            if (event.target === self.el) {
                self.handleHide();
            }
        });
        this.el.addEventListener('shown.bs.modal', function (event) {
            if (event.target === self.el) {
                self.handleShown();
            }
        });
        this.el.addEventListener('hidden.bs.modal', function (event) {
            if (event.target === self.el) {
                self.handleHidden();
            }
        });

        this._bsModal.show();

        return this;
    },

    // The flag is consumed by the next close(), whoever calls it
    preventClose: function () {
        this._preventClose = true;
    },

    close: function () {
        if (this._preventClose) {
            this._preventClose = false;
            return;
        }

        this.hide();
    },

    hide: function () {
        if (this.isDestroyed() || !this._bsModal) {
            return;
        }

        // Bootstrap ignores hide() while the show transition runs: close from the shown handler
        if (!this._shown) {
            this._closePending = true;
            return;
        }

        this._closing = true;
        this._bsModal.hide();
    },

    okClicked: function (event) {
        event.preventDefault();
        this.trigger('ok', this);
        this.content.trigger('ok', this);
        this.close();
    },

    // Cancel button, Esc and backdrop click end up here; a close() call does not
    handleHide: function () {
        if (!this._closing) {
            this.trigger('cancel', this);
            this.content.trigger('cancel', this);
        }
    },

    handleShown: function () {
        this._shown = true;

        var ok = this.el.querySelector('.ok');
        if (ok) {
            // preventScroll keeps a tall modal scrolled to the top
            ok.focus({preventScroll: true});
        }

        this.trigger('shown', this);
        this.content.trigger('shown', this);

        if (this._closePending) {
            this._closePending = false;
            this.hide();
        }
    },

    handleHidden: function () {
        this._bsModal.dispose();
        this._bsModal = null;

        if (openModal === this) {
            openModal = null;
        }

        this.trigger('hidden', this);
        this.content.trigger('hidden', this);

        if (this._previousFocus && document.body.contains(this._previousFocus)) {
            this._previousFocus.focus();
        }

        this.destroy();
    }
});
