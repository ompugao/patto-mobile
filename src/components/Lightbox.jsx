// Lightbox - full-screen viewer for the original (non-downscaled) image
// Tap the image to toggle between fit-to-screen and 1:1; tap the backdrop, ✕,
// Escape, or the back button to close.

import { useStore } from '../lib/store';
import { useEffect, useState } from 'react';
import './Lightbox.css';

export function Lightbox() {
    const { lightbox, closeLightbox } = useStore();
    const [zoomed, setZoomed] = useState(false);
    const [loaded, setLoaded] = useState(false);

    // Reset per image
    useEffect(() => {
        setZoomed(false);
        setLoaded(false);
    }, [lightbox?.src]);

    useEffect(() => {
        if (!lightbox) return;
        const onKey = (e) => {
            if (e.key === 'Escape') closeLightbox();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [lightbox, closeLightbox]);

    if (!lightbox) return null;

    return (
        <div className={`lightbox${zoomed ? ' zoomed' : ''}`} onClick={closeLightbox}>
            <button
                type="button"
                className="lightbox-close"
                aria-label="Close"
                onClick={(e) => { e.stopPropagation(); closeLightbox(); }}
            >
                ✕
            </button>
            {!loaded && <div className="lightbox-loading">Loading original…</div>}
            <img
                className="lightbox-image"
                src={lightbox.src}
                alt={lightbox.alt || ''}
                onLoad={() => setLoaded(true)}
                onClick={(e) => { e.stopPropagation(); setZoomed((z) => !z); }}
            />
            {lightbox.alt && !zoomed && (
                <div className="lightbox-caption" onClick={(e) => e.stopPropagation()}>
                    {lightbox.alt}
                </div>
            )}
        </div>
    );
}
