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
const SLICE_STEP = 192;
const SLICE_OVERSCAN = 96;

function roundedRectSDF(px: number, py: number, halfW: number, halfH: number, radius: number, cornerPower: number): number {
	const qx = Math.abs(px) - halfW + radius;
	const qy = Math.abs(py) - halfH + radius;
	if (cornerPower !== 2 && qx > 0 && qy > 0) {
		return (qx ** cornerPower + qy ** cornerPower) ** (1 / cornerPower) - radius;
	}
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

	const wallpaperSelector = '.glass-card:not(nav, [data-glass-photo]), .link-card[data-glass], #waline .wl-panel, #waline .wl-card-item';
	const targets = new Set(document.querySelectorAll<HTMLElement>(
		`${wallpaperSelector}, .nav-glass-background, .menu-glass-background, .nav-lens, #theme-toggle, .search-results`,
	));
	if (!targets.size) return;

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
	const wallpaperLayers = new Map<HTMLElement, { layer: HTMLSpanElement; top: number }>();
	let nextId = 1;
	let rafId = 0;

	const clearElementFilter = (el: HTMLElement) => {
		el.style.removeProperty('backdrop-filter');
		el.style.removeProperty('-webkit-backdrop-filter');
		if (el.classList.contains('glass-wallpaper-optics')) el.style.removeProperty('filter');
		el.removeAttribute('data-liquid-glass-ready');
	};

	const setElementFilter = (el: HTMLElement, property: string, value: string) => {
		if (property === 'backdrop-filter') el.style.setProperty('-webkit-backdrop-filter', value);
		el.style.setProperty(property, value);
		el.setAttribute('data-liquid-glass-ready', '');
	};

	const buildFilterCss = (el: HTMLElement, id: string): string => {
		if (el.matches('.nav-lens, .nav-glass-background, .menu-glass-background')) {
			return `url(#${id}) blur(var(--navigation-glass-blur, var(--liquid-glass-blur))) saturate(var(--liquid-glass-saturation))`;
		}
		return `url(#${id}) blur(var(--liquid-glass-blur)) saturate(var(--liquid-glass-saturation))`;
	};

	const applyFilter = (el: HTMLElement, surface?: HTMLElement, top = 0) => {
		if (reducedTransparency.matches) {
			clearElementFilter(el);
			return;
		}
		const width = el.offsetWidth;
		const height = el.offsetHeight;
		if (width <= 0 || height <= 0) {
			clearElementFilter(el);
			return;
		}

		const filterProperty = surface ? 'filter' : 'backdrop-filter';
		const style = getComputedStyle(surface ?? el);
		const padding = surface ? parseFloat(style.getPropertyValue('--liquid-glass-padding')) : 0;
		const halfW = (surface?.clientWidth ?? width) * 0.5;
		const halfH = (surface?.clientHeight ?? height) * 0.5;
		const computedRadius = parseFloat(style.borderTopLeftRadius) || 0;
		const radius = Math.min(computedRadius, halfW, halfH);
		const corner = style.getPropertyValue('corner-top-left-shape').match(/superellipse\(([^)]+)\)/);
		const cornerPower = corner ? 2 ** Number(corner[1]) : 2;
		const bounds = surface?.getBoundingClientRect();
		// Fixed wallpaper pixels end at the viewport, including on narrow phones.
		const leftTravel = bounds ? Math.max(0, Math.min(24, Math.floor(bounds.left) - 6)) : 24;
		const rightTravel = bounds ? Math.max(0, Math.min(24, Math.floor(document.documentElement.clientWidth - bounds.right) - 6)) : 24;
		const isLongSurface = halfH * 2 > FULL_FILTER_HEIGHT;
		const isInterior = top > 0 && top + height - 2 * padding < 2 * halfH;
		if (isLongSurface && isInterior) {
			// The middle of a long article needs only the native blur. Edge slices retain the lens.
			setElementFilter(el, filterProperty, 'blur(var(--liquid-glass-blur)) saturate(var(--liquid-glass-saturation))');
			return;
		}
		const signature = [width, height, halfW, halfH, radius, padding, cornerPower, top, leftTravel, rightTravel].join(':');

		let entry = entries.get(el);
		if (entry && entry.signature === signature) {
			const filterCss = buildFilterCss(el, entry.id);
			if (el.style.getPropertyValue(filterProperty) !== filterCss) {
				setElementFilter(el, filterProperty, filterCss);
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

		const minHalf = Math.min(halfW, halfH);
		const bevelWidth = Math.min(40, minHalf * 0.38);
		const strength = surface ? Math.min(24, bevelWidth * 0.65) : Math.min(8, bevelWidth * 0.65);
		const scale = Math.max(2, strength * 2);
		const centerStrength = Math.min(2, minHalf * 0.18, strength);
		// A padded wallpaper copy reaches beyond the outline. Live backdrop filters stay within their surface.
		const edgeStrength = surface ? strength : -strength;

		const mapScale = Math.min(0.5, 512 / Math.max(width, height));
		const mw = Math.max(16, Math.round(width * mapScale));
		const mh = Math.max(16, Math.round(height * mapScale));

		if (mapCanvas.width !== mw) mapCanvas.width = mw;
		if (mapCanvas.height !== mh) mapCanvas.height = mh;

		const imgData = mapCtx.createImageData(mw, mh);
		const data = imgData.data;
		const eps = 1.0;

		for (let my = 0; my < mh; my++) {
			const py = ((my + 0.5) / mh) * height + top - padding - halfH;
			for (let mx = 0; mx < mw; mx++) {
				const px = ((mx + 0.5) / mw) * width - padding - halfW;
				const sd = roundedRectSDF(px, py, halfW, halfH, radius, cornerPower);
				const d = Math.max(0, -sd);

				// A gentle magnification in the face connects continuously to the stronger bevel.
				let dx = -(px / halfW) * centerStrength;
				let dy = isLongSurface ? 0 : -(py / halfH) * centerStrength;
				if (d < bevelWidth) {
					const gx =
						roundedRectSDF(px + eps, py, halfW, halfH, radius, cornerPower) -
						roundedRectSDF(px - eps, py, halfW, halfH, radius, cornerPower);
					const gy =
						roundedRectSDF(px, py + eps, halfW, halfH, radius, cornerPower) -
						roundedRectSDF(px, py - eps, halfW, halfH, radius, cornerPower);
					const gLen = Math.hypot(gx, gy);
					const nx = gLen > 1e-4 ? gx / gLen : 0;
					const ny = gLen > 1e-4 ? gy / gLen : -1;

					const curve = smoothStep(0, 1, 1 - d / bevelWidth);
					dx = dx * (1 - curve) + nx * edgeStrength * curve;
					dy = dy * (1 - curve) + ny * edgeStrength * curve;
				}
				if (surface) dx = Math.max(-leftTravel, Math.min(rightTravel, dx));

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
		setElementFilter(el, filterProperty, filterCss);
	};

	const sliceSize = (height: number) => Math.min(height, window.innerHeight + SLICE_STEP + SLICE_OVERSCAN * 2);
	const sliceTop = (surface: HTMLElement, height: number, size: number) => {
		const scrollOffset = -surface.getBoundingClientRect().top - SLICE_OVERSCAN;
		return Math.max(0, Math.min(height - size, Math.floor(scrollOffset / SLICE_STEP) * SLICE_STEP));
	};

	const updateElement = (surface: HTMLElement) => {
		if (!surface.matches(wallpaperSelector)) {
			applyFilter(surface);
			return;
		}
		const surfaceHeight = surface.clientHeight;
		let entry = wallpaperLayers.get(surface);
		if (reducedTransparency.matches && !entry) return;

		if (!entry) {
			const clip = document.createElement('span');
			clip.className = 'glass-wallpaper-clip';
			clip.setAttribute('aria-hidden', 'true');
			const layer = document.createElement('span');
			layer.className = 'glass-wallpaper-optics';
			clip.append(layer);
			surface.prepend(clip);
			entry = { layer, top: 0 };
			wallpaperLayers.set(surface, entry);
		}

		// Large articles paint one overscanned slice. Its map still uses the true article edges.
		const sliced = surfaceHeight > FULL_FILTER_HEIGHT;
		const size = sliced ? sliceSize(surfaceHeight) : surfaceHeight;
		const top = sliced ? sliceTop(surface, surfaceHeight, size) : 0;
		const { layer } = entry;
		entry.top = top;
		layer.style.top = `calc(${top}px - var(--liquid-glass-padding))`;
		layer.style.height = `calc(${size}px + var(--liquid-glass-padding) * 2)`;
		applyFilter(layer, surface, top);
		surface.toggleAttribute('data-liquid-glass-wallpaper', layer.hasAttribute('data-liquid-glass-ready'));
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

	const comments = document.getElementById('waline');
	if (comments) {
		const refreshComments = () => {
			for (const surface of targets) {
				if (surface.isConnected) continue;
				const optics = wallpaperLayers.get(surface)?.layer ?? surface;
				entries.get(optics)?.filter.remove();
				entries.delete(optics);
				wallpaperLayers.delete(surface);
				observer.unobserve(surface);
				pending.delete(surface);
				targets.delete(surface);
			}
			comments.querySelectorAll<HTMLElement>('.wl-panel, .wl-card-item').forEach(surface => {
				if (targets.has(surface)) return;
				targets.add(surface);
				observer.observe(surface);
				schedule(surface);
			});
		};
		new MutationObserver(refreshComments).observe(comments, { childList: true, subtree: true });
		refreshComments();
	}

	reducedTransparency.addEventListener('change', () => schedule());
	window.addEventListener('pageshow', () => schedule());
	const updateReadingLayers = () => wallpaperLayers.forEach((entry, surface) => {
		const height = surface.clientHeight;
		if (height > FULL_FILTER_HEIGHT && sliceTop(surface, height, sliceSize(height)) !== entry.top) schedule(surface);
	});
	window.addEventListener('scroll', updateReadingLayers, { passive: true });
	window.addEventListener('resize', () => schedule());

	flush();
}
