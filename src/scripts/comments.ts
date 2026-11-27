const serverURL = 'https://comment.chengxii.dpdns.org/';
const avatarDomain = '@chengxii.org';
const customAvatarMail = `custom${avatarDomain}`;
const avatarHashes = [
	'ee3172ce9bdcdd1ed637d0477aa8da72', 'ec7fe3e67594ce450f170b5c83b61d73',
	'6faf5609dc22ca4a81d3583bf79cef7c', '43214eb4809dd00da5b4f8699f10eae0',
	'f507c23111ed1925b37a9ce760a052da', 'd5c17c1a927336a3608ff8a4c7d8b04c',
	'1b3b4304e2007b6e0a51451acdde8336', 'b0f3df21078bad42575fb1099ae44e92',
	'b69ed8e9483c8b88396f60736211a4b7', 'd93da5df25360b4be374bf59b0b78d97',
	'b06b37b3b15777c3670dce8525b9df63', '473bed837cb652c74821697a3ccca7e0',
	'51b467f9db15dcebfdbc4cdd6ee7dedc', '0bbf98032a6ab1f06d178db92f6a2891',
	'47cf7f3f7ef443f7a9131beee606def3', '273443a137b620c67ae6c4fb0d9bdc6c',
];

async function makeAvatar(file: File) {
	const source = URL.createObjectURL(file);
	try {
		const image = new Image();
		image.src = source;
		await image.decode();
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 48;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('No canvas context');
		const size = Math.min(image.naturalWidth, image.naturalHeight);
		context.drawImage(image, (image.naturalWidth - size) / 2, (image.naturalHeight - size) / 2, size, size, 0, 0, 48, 48);
		return canvas.toDataURL('image/jpeg', 0.7);
	} finally {
		URL.revokeObjectURL(source);
	}
}

export async function mountComments(root: HTMLElement, template: HTMLTemplateElement) {
	const { init } = await import('@waline/client');
	let selectedAvatar = '';
	let uploadedAvatar = '';
	try {
		const visitor = JSON.parse(localStorage.getItem('WALINE_USER') ?? 'null');
		const mail = typeof visitor?.mail === 'string' ? visitor.mail : '';
		if (mail && !mail.includes('@')) localStorage.removeItem('WALINE_USER');
		if (/^avatar(?:[1-9]|1[0-6])@chengxii\.org$/.test(mail)) selectedAvatar = mail.split('@')[0];
	} catch { /* Comments also work when browser storage is unavailable. */ }

	init({
		el: root,
		serverURL,
		dark: 'html[data-theme="dark"]',
		meta: ['nick', 'mail'],
		requiredMeta: ['nick', 'mail'],
		login: 'disable',
		lang: 'zh-CN',
		emoji: ['weibo', 'bilibili', 'qq'].map(set => `//npm.elemecdn.com/@waline/emojis@1.1.0/${set}`),
		locale: { nick: '昵称', placeholder: '写下你的留言…' },
	});

	// Keep previously stored avatar payloads compatible with the same Waline server.
	const originalFetch = window.fetch.bind(window);
	const origin = new URL(serverURL).origin;
	window.fetch = (input, options) => {
		if (options?.method === 'POST' && typeof options.body === 'string' && uploadedAvatar) {
			const address = new URL(input instanceof Request ? input.url : input, location.href);
			if (address.origin === origin && ['/api/comment', '/comment'].includes(address.pathname)) {
				let payload;
				try { payload = JSON.parse(options.body); } catch { return originalFetch(input, options); }
				if (payload?.mail === customAvatarMail && typeof payload.comment === 'string') {
					payload.comment += `\n<img class="custom-user-avatar" src="${uploadedAvatar}" style="display:none;" />`;
					return originalFetch(input, { ...options, body: JSON.stringify(payload) });
				}
			}
		}
		return originalFetch(input, options);
	};

	const syncAvatar = (panel: Element) => {
		const mail = panel.querySelector<HTMLInputElement>('.wl-header input[name="mail"]');
		if (!mail) return;
		const value = selectedAvatar ? selectedAvatar + avatarDomain : '';
		if (mail.value === value) return;
		mail.value = value;
		mail.dispatchEvent(new Event('input', { bubbles: true }));
	};

	const showStatus = (panel: Element, message: string) => {
		const status = panel.querySelector<HTMLElement>('.comment-avatar-status');
		if (status) {
			status.textContent = message;
			status.hidden = !message;
		}
	};

	const mountPicker = (panel: HTMLElement) => {
		const header = panel.querySelector('.wl-header');
		if (!header?.querySelector('input[name="mail"]')) return;
		if (header.querySelector('.comment-avatar-picker')) {
			syncAvatar(panel);
			return;
		}
		const fragment = template.content.cloneNode(true) as DocumentFragment;
		const picker = fragment.querySelector<HTMLElement>('.comment-avatar-picker')!;
		const choices = Array.from(picker.querySelectorAll<HTMLButtonElement>('[data-avatar]'));
		const upload = picker.querySelector<HTMLButtonElement>('[data-avatar-upload]')!;
		const fileInput = picker.querySelector<HTMLInputElement>('[data-avatar-file]')!;

		const renderSelection = () => {
			for (const choice of choices) choice.setAttribute('aria-pressed', String(choice.dataset.avatar === selectedAvatar));
			upload.setAttribute('aria-pressed', String(selectedAvatar === 'custom'));
			upload.style.backgroundImage = selectedAvatar === 'custom' ? `url(${uploadedAvatar})` : '';
			syncAvatar(panel);
		};
		const select = (choice: HTMLButtonElement) => {
			selectedAvatar = choice.dataset.avatar!;
			renderSelection();
			showStatus(panel, '');
		};

		for (const choice of choices) choice.addEventListener('click', () => select(choice));
		picker.querySelector('[data-avatar-random]')?.addEventListener('click', () => {
			const alternatives = choices.filter(choice => choice.dataset.avatar !== selectedAvatar);
			const choice = alternatives[Math.floor(Math.random() * alternatives.length)];
			select(choice);
			choice.scrollIntoView({ inline: 'nearest', block: 'nearest' });
		});
		upload.addEventListener('click', () => fileInput.click());
		fileInput.addEventListener('change', async () => {
			const file = fileInput.files?.[0];
			fileInput.value = '';
			if (!file) return;
			try {
				const avatar = await makeAvatar(file);
				if (!panel.isConnected) return;
				uploadedAvatar = avatar;
				selectedAvatar = 'custom';
				renderSelection();
				showStatus(panel, '已选用上传的头像。');
			} catch {
				showStatus(panel, '这张图片无法读取，请换一张。');
			}
		});

		header.append(fragment);
		renderSelection();
	};

	const renderPostedAvatars = () => {
		for (const card of root.querySelectorAll('.wl-card-item')) {
			const avatar = card.querySelector<HTMLImageElement>(':scope > .wl-user img');
			if (!avatar) continue;
			const custom = card.querySelector<HTMLImageElement>('.wl-content img.custom-user-avatar');
			if (custom?.closest('.wl-card-item') === card && custom.src.startsWith('data:image/jpeg;base64,')) {
				avatar.src = custom.src;
				custom.remove();
				continue;
			}
			const index = avatarHashes.findIndex(hash => avatar.src.includes(hash));
			if (index >= 0) avatar.src = `/avatars/avatar${index + 1}.${index < 8 ? 'png' : 'jpg'}`;
		}
	};

	const refresh = () => {
		root.querySelectorAll<HTMLElement>('.wl-panel').forEach(mountPicker);
		renderPostedAvatars();
	};
	const observer = new MutationObserver(refresh);
	observer.observe(root, { childList: true, subtree: true });
	refresh();

	const validate = (event: Event) => {
		const panel = (event.target as Element | null)?.closest('.wl-panel');
		const nick = panel?.querySelector<HTMLInputElement>('.wl-header input[name="nick"]');
		if (!panel || !nick) return;
		if (nick.value.trim() && selectedAvatar) {
			syncAvatar(panel);
			return;
		}
		event.preventDefault();
		event.stopImmediatePropagation();
		showStatus(panel, nick.value.trim() ? '请选择一个头像。' : '请先填写昵称。');
		(nick.value.trim() ? panel.querySelector<HTMLElement>('[data-avatar]') : nick)?.focus();
	};
	root.addEventListener('submit', validate, true);
	root.addEventListener('click', (event) => {
		if ((event.target as Element).closest('.wl-panel button[type="submit"]')) validate(event);
	}, true);
	root.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) validate(event);
	}, true);
}
