interface FilterEntry {
	id: string;
	filter: SVGFilterElement;
	feImage: SVGFEImageElement;
	feDisp: SVGFEDisplacementMapElement;
	signature: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const FULL_FILTER_HEIGHT = 1400;
const READING_OVERSCAN = 72;

function roundedRectSDF(px: number, py: number, halfW: number, halfH: number, radius: number): number {
	const qx = Math.abs(px) - halfW + radius;
	const qy = Math.abs(py) - halfH + radius;
	return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
}

function smoothStep(a: number, b: number, x: number): number {
	const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
}

export function mountLiquidGlassSvg() {
	if (typeof window === 'undefined' || typeof document === 'undefined') return;

	const reducedTransparency = window.matchMedia('(prefers-reduced-transparency: reduce)');
	const isChromium =
		/Chrome|Chromium|Edg/i.test(navigator.userAgent) && !/Firefox/i.test(navigator.userAgent);
	if (!isChromium) return;

	const targets = Array.from(
		document.querySelectorAll<HTMLElement>(
			'.glass-card:not(nav, [data-glass-photo]), .link-card, .menu-glass-background, .nav-lens, #theme-toggle, .search-results',
		),
	);
	if (!targets.length) return;

	let svg = document.getElementById('liquid-glass-svg-defs') as SVGSVGElement | null;
	if (!svg) {
		svg = document.createElementNS(SVG_NS, 'svg');
		svg.id = 'liquid-glass-svg-defs';
		svg.setAttribute('aria-hidden', 'true');
		svg.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;pointer-events:none;z-index:-1;';
		const defs = document.createElementNS(SVG_NS, 'defs');
		svg.appendChild(defs);
		document.body.appendChild(svg);
	}
	const defs = svg.querySelector('defs') ?? svg.appendChild(document.createElementNS(SVG_NS, 'defs'));

	const mapCanvas = document.createElement('canvas');
	const mapCtx = mapCanvas.getContext('2d');
	if (!mapCtx) return;

	const entries = new Map<HTMLElement, FilterEntry>();
	const readingLayers = new Map<HTMLElement, HTMLSpanElement>();
	let nextId = 1;
	let rafId = 0;

	const clearElementFilter = (el: HTMLElement) => {
		el.style.removeProperty('backdrop-filter');
		el.style.removeProperty('-webkit-backdrop-filter');
		el.removeAttribute('data-liquid-glass-ready');
	};

	const buildFilterCss = (el: HTMLElement, id: string): string => {
		if (el.matches('.nav-lens, .menu-glass-background')) {
			return `url(#${id}) blur(var(--navigation-glass-blur, 1px)) contrast(var(--navigation-glass-contrast, 1.12)) brightness(var(--navigation-glass-brightness, 1.05)) saturate(var(--navigation-glass-saturation, 1.2))`;
		}
		if (el.id === 'theme-toggle') {
			return `url(#${id}) blur(1px) contrast(1.12) brightness(1.07) saturate(125%)`;
		}
		if (el.dataset.glassTier === 'reading') {
			return `url(#${id}) blur(2.2px) contrast(1.05) brightness(1.03) saturate(120%)`;
		}
		return `url(#${id}) blur(1px) contrast(1.12) brightness(1.05) saturate(120%)`;
	};

	const applyFilter = (el: HTMLElement) => {
		if (reducedTransparency.matches) {
			clearElementFilter(el);
			return;
		}
		const width = el.offsetWidth;
		const height = el.offsetHeight;
		if (width <= 0 || height <= 0 || (height > FULL_FILTER_HEIGHT && !el.classList.contains('liquid-glass-reading-layer'))) {
			clearElementFilter(el);
			return;
		}

		const computedRadius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
		const radius = Math.min(computedRadius, width / 2, height / 2);
		const signature = `${width}x${height}x${Math.round(radius)}`;

		let entry = entries.get(el);
		if (entry && entry.signature === signature) {
			const filterCss = buildFilterCss(el, entry.id);
			if (el.style.backdropFilter !== filterCss) {
				el.style.setProperty('-webkit-backdrop-filter', filterCss);
				el.style.setProperty('backdrop-filter', filterCss);
				el.setAttribute('data-liquid-glass-ready', '');
			}
			return;
		}

		if (!entry) {
			const id = `lg-filter-${nextId++}`;
			const filter = document.createElementNS(SVG_NS, 'filter');
			filter.id = id;
			filter.setAttribute('filterUnits', 'userSpaceOnUse');
			filter.setAttribute('color-interpolation-filters', 'sRGB');

			const feImage = document.createElementNS(SVG_NS, 'feImage');
			feImage.setAttribute('preserveAspectRatio', 'none');
			feImage.setAttribute('result', 'map');

			const feDisp = document.createElementNS(SVG_NS, 'feDisplacementMap');
			feDisp.setAttribute('in', 'SourceGraphic');
			feDisp.setAttribute('in2', 'map');
			feDisp.setAttribute('xChannelSelector', 'R');
			feDisp.setAttribute('yChannelSelector', 'G');

			filter.append(feImage, feDisp);
			defs.appendChild(filter);
			entry = { id, filter, feImage, feDisp, signature: '' };
			entries.set(el, entry);
		}

		const halfW = width * 0.5;
		const halfH = height * 0.5;
		const minHalf = Math.min(halfW, halfH);
		const bevelWidth = Math.max(8, Math.min(26, minHalf * 0.45));

		let strength: number;
		if (el.classList.contains('nav-lens') || el.id === 'theme-toggle') {
			strength = Math.min(14, minHalf * 0.55);
		} else if (el.dataset.glassTier === 'reading') {
			strength = 12;
		} else {
			strength = Math.min(22, bevelWidth * 0.85);
		}
		const scale = Math.max(2, strength * 2);
		const centerStrength = Math.min(el.dataset.glassTier === 'intro' ? 9 : 4, minHalf * 0.18, strength);

		const mapScale = Math.min(0.5, 512 / Math.max(width, height));
		const mw = Math.max(16, Math.round(width * mapScale));
		const mh = Math.max(16, Math.round(height * mapScale));

		if (mapCanvas.width !== mw) mapCanvas.width = mw;
		if (mapCanvas.height !== mh) mapCanvas.height = mh;

		const imgData = mapCtx.createImageData(mw, mh);
		const data = imgData.data;
		const eps = 1.0;

		for (let my = 0; my < mh; my++) {
			const py = ((my + 0.5) / mh) * height - halfH;
			for (let mx = 0; mx < mw; mx++) {
				const px = ((mx + 0.5) / mw) * width - halfW;
				const sd = roundedRectSDF(px, py, halfW, halfH, radius);
				const d = Math.max(0, -sd);

				// A gentle magnification in the face connects continuously to the stronger bevel.
				let dx = -(px / halfW) * centerStrength;
				let dy = -(py / halfH) * centerStrength;
				if (d < bevelWidth) {
					const gx =
						roundedRectSDF(px + eps, py, halfW, halfH, radius) -
						roundedRectSDF(px - eps, py, halfW, halfH, radius);
					const gy =
						roundedRectSDF(px, py + eps, halfW, halfH, radius) -
						roundedRectSDF(px, py - eps, halfW, halfH, radius);
					const gLen = Math.hypot(gx, gy);
					const nx = gLen > 1e-4 ? gx / gLen : 0;
					const ny = gLen > 1e-4 ? gy / gLen : -1;

					const curve = smoothStep(0, 1, 1 - d / bevelWidth);
					dx = dx * (1 - curve) - nx * strength * curve;
					dy = dy * (1 - curve) - ny * strength * curve;
				}

				const idx = (my * mw + mx) * 4;
				data[idx] = Math.max(0, Math.min(255, Math.round((dx / scale + 0.5) * 255)));
				data[idx + 1] = Math.max(0, Math.min(255, Math.round((dy / scale + 0.5) * 255)));
				data[idx + 2] = 128;
				data[idx + 3] = 255;
			}
		}

		mapCtx.putImageData(imgData, 0, 0);
		const dataUrl = mapCanvas.toDataURL('image/png');

		entry.filter.setAttribute('x', '0');
		entry.filter.setAttribute('y', '0');
		entry.filter.setAttribute('width', String(width));
		entry.filter.setAttribute('height', String(height));

		entry.feImage.setAttribute('width', String(width));
		entry.feImage.setAttribute('height', String(height));
		entry.feImage.setAttribute('href', dataUrl);
		entry.feImage.setAttributeNS(XLINK_NS, 'xlink:href', dataUrl);

		entry.feDisp.setAttribute('scale', scale.toFixed(2));
		entry.signature = signature;

		const filterCss = buildFilterCss(el, entry.id);
		el.style.setProperty('-webkit-backdrop-filter', filterCss);
		el.style.setProperty('backdrop-filter', filterCss);
		el.setAttribute('data-liquid-glass-ready', '');
	};

	const updateElement = (surface: HTMLElement) => {
		const surfaceHeight = surface.clientHeight;
		const needsSlice = surface.dataset.glassTier === 'reading' && surfaceHeight > FULL_FILTER_HEIGHT
			&& !reducedTransparency.matches;
		let layer = readingLayers.get(surface);

		if (!needsSlice) {
			if (layer) {
				entries.get(layer)?.filter.remove();
				entries.delete(layer);
				layer.remove();
				readingLayers.delete(surface);
				surface.removeAttribute('data-liquid-glass-sliced');
			}
			applyFilter(surface);
			return;
		}

		if (!layer) {
			clearElementFilter(surface);
			layer = document.createElement('span');
			layer.className = 'liquid-glass-reading-layer';
			layer.dataset.glassTier = 'reading';
			layer.setAttribute('aria-hidden', 'true');
			surface.prepend(layer);
			readingLayers.set(surface, layer);
		}

		// Keep the moving edges outside the viewport except at the true ends of the article.
		const size = Math.min(surfaceHeight, window.innerHeight + READING_OVERSCAN * 2);
		const top = Math.max(0, Math.min(surfaceHeight - size, Math.round(-surface.getBoundingClientRect().top - READING_OVERSCAN)));
		const height = `${size}px`;
		const transform = `translateY(${top}px)`;
		if (layer.style.height !== height) layer.style.height = height;
		if (layer.style.transform !== transform) layer.style.transform = transform;
		applyFilter(layer);
		surface.toggleAttribute('data-liquid-glass-sliced', layer.hasAttribute('data-liquid-glass-ready'));
	};

	const pending = new Set<HTMLElement>(targets);
	const flush = () => {
		rafId = 0;
		for (const el of pending) {
			updateElement(el);
		}
		pending.clear();
	};

	const schedule = (el?: HTMLElement) => {
		if (el) {
			pending.add(el);
		} else {
			targets.forEach((t) => pending.add(t));
		}
		if (!rafId) {
			rafId = requestAnimationFrame(flush);
		}
	};

	const observer = new ResizeObserver((items) => {
		for (const item of items) {
			if (item.target instanceof HTMLElement) {
				schedule(item.target);
			}
		}
	});
	targets.forEach((el) => observer.observe(el));

	reducedTransparency.addEventListener('change', () => schedule());
	window.addEventListener('pageshow', () => schedule());
	const updateReadingLayers = () => readingLayers.forEach((_layer, surface) => schedule(surface));
	window.addEventListener('scroll', updateReadingLayers, { passive: true });
	window.addEventListener('resize', updateReadingLayers);

	flush();
}
