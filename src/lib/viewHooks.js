// View transition hooks registry
// Each view can register lifecycle hooks for navigation transitions

// Hook registry: { [view]: { onLeave?, onEnter?, saveContext? } }
const viewHooks = {};

/**
 * Register hooks for a view
 * @param {string} view - The view identifier (from View enum)
 * @param {Object} hooks - Hook functions
 * @param {Function} [hooks.saveContext] - (state) => context to save in history
 * @param {Function} [hooks.onLeave] - (state, actions) => state updates or Promise
 * @param {Function} [hooks.onEnter] - (context, state) => state updates
 */
export function registerViewHooks(view, hooks) {
    viewHooks[view] = { ...viewHooks[view], ...hooks };
}

/**
 * Get hooks for a view
 * @param {string} view - The view identifier
 * @returns {Object} Hook functions or empty object
 */
export function getViewHooks(view) {
    return viewHooks[view] || {};
}

/**
 * Call saveContext hook if registered
 * @param {string} view - Current view
 * @param {Object} state - Current state
 * @returns {Object|null} Context to save or null
 */
export function callSaveContext(view, state) {
    const hooks = getViewHooks(view);
    if (hooks.saveContext) {
        return hooks.saveContext(state);
    }
    return null;
}

/**
 * Call onLeave hook if registered
 * @param {string} view - View being left
 * @param {Object} state - Current state
 * @param {Object} actions - Store actions (for async operations like save)
 * @returns {Promise<Object>} State updates to apply
 */
export async function callOnLeave(view, state, actions) {
    const hooks = getViewHooks(view);
    if (hooks.onLeave) {
        const result = hooks.onLeave(state, actions);
        return result instanceof Promise ? await result : result;
    }
    return {};
}

/**
 * Call onEnter hook if registered
 * @param {string} view - View being entered
 * @param {Object} context - Saved context from history (if any)
 * @param {Object} state - Current state
 * @returns {Object} State updates to apply
 */
export function callOnEnter(view, context, state) {
    const hooks = getViewHooks(view);
    if (hooks.onEnter) {
        return hooks.onEnter(context, state);
    }
    return {};
}
