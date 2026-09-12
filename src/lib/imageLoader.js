// Loads large, not-yet-cached images without ever blocking a WebView request.
//
// The renderer leaves such images without `src` (`data-pending-src` + `data-prepare`).
// When one comes near the viewport we ask Rust to decode/cache it in the background
// (`prepare_images`, returns immediately) and set `src` on the `image-ready` event,
// which is then a fast disk-cache hit. This matters on Android, where wry blocks the
// WebView's shared request thread until a custom-protocol handler responds — a
// slow decode there stalls Tauri IPC (see src-tauri/src/image_proxy.rs).

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** path -> Set<HTMLImageElement> waiting for that file */
const waiting = new Map();
/** paths already sent to Rust (avoid duplicate decodes across bodies) */
const requested = new Set();
/** batch of paths to request on the next tick */
let queue = [];
let flushTimer = null;
let listening = false;

const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(
    (entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            observer.unobserve(entry.target);
            request(entry.target);
        }
    },
    { rootMargin: '150% 0px' },
);

/** Watch every pending image inside `body` (a note body element). */
export function attach(body) {
    ensureListener();
    const imgs = body.querySelectorAll('img[data-pending-src]');
    for (const img of imgs) {
        if (observer) observer.observe(img);
        else request(img);
    }
}

/** Stop watching images of a body that is being evicted. */
export function detach(body) {
    for (const img of body.querySelectorAll('img[data-pending-src]')) {
        observer?.unobserve(img);
        const path = img.dataset.prepare;
        waiting.get(path)?.delete(img);
    }
}

function request(img) {
    const path = img.dataset.prepare;
    if (!path) return;
    if (!waiting.has(path)) waiting.set(path, new Set());
    waiting.get(path).add(img);
    if (requested.has(path)) return;
    requested.add(path);
    queue.push(path);
    if (!flushTimer) flushTimer = setTimeout(flush, 0);
}

async function flush() {
    flushTimer = null;
    const paths = queue;
    queue = [];
    if (paths.length === 0) return;
    try {
        await invoke('prepare_images', { paths });
    } catch (err) {
        console.error('prepare_images failed:', err);
        for (const path of paths) settle(path, false);
    }
}

function settle(path, ok) {
    requested.delete(path);
    const imgs = waiting.get(path);
    waiting.delete(path);
    if (!imgs) return;
    for (const img of imgs) {
        if (ok) {
            img.src = img.dataset.pendingSrc;
        } else {
            img.classList.add('patto-image-missing');
        }
        delete img.dataset.pendingSrc;
        delete img.dataset.prepare;
    }
}

function ensureListener() {
    if (listening) return;
    listening = true;
    listen('image-ready', (event) => {
        const { path, ok } = event.payload;
        settle(path, ok);
    }).catch((err) => {
        listening = false;
        console.error('image-ready listener failed:', err);
    });
}
