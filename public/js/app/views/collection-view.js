var Marionette = require('marionette');

// Backbone 1.6.1 fires `update` for every merging `set()` and Marionette 4 re-attaches all
// children on `update`; the socket pushes merge every few seconds. This overrides a private
// Marionette 4.1.3 method, which is safe only while the version stays pinned.
var isUnchanged = function (view, collection, options) {
    var changes = options.changes;
    var views = view._children._views;

    if (changes.added.length || changes.removed.length || views.length !== collection.models.length) {
        return false;
    }

    return views.every(function (child, i) {
        return child.model === collection.models[i];
    });
};

module.exports = Marionette.CollectionView.extend({
    _onCollectionUpdate: function (collection, options) {
        if (isUnchanged(this, collection, options)) {
            return;
        }

        return Marionette.CollectionView.prototype._onCollectionUpdate.apply(this, arguments);
    }
});
