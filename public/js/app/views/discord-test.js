// Orchestrates the op-mode "Send test message" action with exception-safe busy handling. Extracted
// from the view (which cannot be required outside webpack) so this ordering can be unit tested. The
// busy state is always cleared BEFORE the success/error alert runs, so an alert that throws can
// never leave the button stuck disabled. DOM-free and dependency-free on purpose.
//
// hooks:
//   isBusy()      -> true if a test is already in flight; a second click is then ignored
//   setBusy(busy) -> reflect the in-flight state (disable/enable the button, set the flag)
//   request(cb)   -> POST the test message, then call cb(err) on completion
//   onSuccess()   -> tell the operator it worked
//   onError(err)  -> tell the operator why it did not
module.exports = function runDiscordTest(hooks) {
    if (hooks.isBusy()) {
        return;
    }

    hooks.setBusy(true);

    hooks.request(function (err) {
        // Clear the busy state before the alert, not after: the alert can throw, and it must never
        // leave the button stuck disabled.
        hooks.setBusy(false);

        if (err) {
            hooks.onError(err);
        } else {
            hooks.onSuccess();
        }
    });
};
