// The only place dialogs are created. Every alert and confirm in the views goes through here, so the
// dialog library is swapped in one file. CommonJS and DOM-free at load time, so mocha can require it.
//
// While a Bootstrap modal is open its focus trap takes the keyboard back from anything outside it, so a
// dialog opened then is rendered inside the open `.modal` (sweetalert2 `target`). The target is the
// `.modal` root, never `.modal-dialog`: a transformed ancestor would break `position: fixed`.
//
// Calls go through module.exports.swal at call time: tests replace it with a fake.
var Swal = require('sweetalert2');
Swal = Swal.default || Swal;

module.exports.swal = Swal;

// Adds `target` only when a modal is open at call time (and a DOM exists), so options stay untouched otherwise.
var withTarget = function (options) {
    var open = typeof document !== 'undefined' && document.querySelector('.modal.show');
    if (open) {
        options.target = open;
    }
    return options;
};

// Shows a message with one OK button. `text` stays text (never html): it can be arbitrary server text.
module.exports.alert = function (type, title, text) {
    return module.exports.swal.fire(withTarget({
        icon: type,
        title: title,
        text: text,
        buttonsStyling: false,
        customClass: {
            confirmButton: 'btn btn-primary'
        }
    }));
};

// options: {title, text, confirmText, danger}. Calls cb() with no arguments, once, only when the
// operator confirms. Cancel, Esc, a backdrop click and close all do nothing.
module.exports.confirm = function (options, cb) {
    return module.exports.swal.fire(withTarget({
        icon: 'warning',
        title: options.title,
        text: options.text,
        showCancelButton: true,
        confirmButtonText: options.confirmText,
        cancelButtonText: 'Cancel',
        reverseButtons: true,
        buttonsStyling: false,
        customClass: {
            confirmButton: options.danger ? 'btn btn-danger' : 'btn btn-warning',
            cancelButton: 'btn btn-secondary'
        }
    })).then(function (result) {
        if (result && result.isConfirmed === true) {
            cb();
        }
    });
};
