const SETTINGS_CONFIG = {
	keys: ["ElementMove", "IgnoreAttachment", "OriginalImageDownload", "DebugMode"],
	defaultValue: false
};
const FILENAME_KEY = 'filenamePattern';
const DEFAULT_FILENAME_PATTERN = '?title';
const ORIGINAL_DELAY_KEY = 'OriginalDownloadDelayMs';
const DEFAULT_ORIGINAL_DELAY_MS = 500;
const DEFAULT_UPDATE_URL = 'https://github.com/bunta-expert/DCInside-Image-Down-Fork';
const VERSION_ENDPOINTS = [
	'https://raw.githubusercontent.com/bunta-expert/DCInside-Image-Down-Fork/main/version.json',
	'https://raw.githubusercontent.com/bunta-expert/DCInside-Image-Down-Fork/main/latest-version.txt'
];
const ALLOWED_KEYWORDS = ['title', 'id', 'gall', 'today', 'wday'];
const REQUIRED_KEYWORD = '?title';
let inputElement;
let feedbackElement;
let delayInputElement;
let delayFeedbackElement;
let versionStatusElement;
let currentVersionElement;
let updateButtonElement;

function validateFilenamePattern(pattern) {
	const WINDOWS_FORBIDDEN_CHARS_REGEX = /[<>:"/\\|*]/;
	const KEYWORD_PATTERN_REGEX = /\?([a-zA-Z0-9]+)/g;
	
	if (pattern.length > 50) {
		return { isValid: false, message: `[Error] 파일명 규칙은 50자를 초과할 수 없습니다.` };
	}
	
	const allQuestionMarks = pattern.match(/\?/g) || [];
	let validKeywords = [];
	let match;
	
	while ((match = KEYWORD_PATTERN_REGEX.exec(pattern)) !== null) {
		validKeywords.push(match[1]);
	}
	
	if (!pattern.includes(REQUIRED_KEYWORD)) {
		return { isValid: false, message: `[Error] ${REQUIRED_KEYWORD} 키워드가 입력되지 않았습니다.` };
	}

	if (WINDOWS_FORBIDDEN_CHARS_REGEX.test(pattern)) {
		return { isValid: false, message: `[Error] 윈도우 금지 문자(< > : " / \\ | *) 포함.` };
	}

	const invalidKeywordsUsed = validKeywords.filter(
		keyword => !ALLOWED_KEYWORDS.includes(keyword)
	);
	if (invalidKeywordsUsed.length > 0) {
		return { isValid: false, message: `[Error] 정의되지 않은 키워드 사용: ?${invalidKeywordsUsed.join(', ?')}` };
	}
	
	if (allQuestionMarks.length !== validKeywords.length) {
		return { isValid: false, message: `[Error] 물음표(?)는 키워드 앞에만 사용되어야 합니다.` };
	}
	
	return { 
		isValid: true, 
		message: '유효한 파일명 패턴입니다.'
	};
}

function displaySaveResult(pattern, message, isSuccess) {
	feedbackElement.style.color = isSuccess ? 'green' : 'red';
	feedbackElement.innerHTML = `<div>${message}</div>`;
	inputElement.addEventListener('input', clearFeedbackOnInput, { once: true });
}

function clearFeedbackOnInput() {
	feedbackElement.innerHTML = '';
}

function validateDelayMs(value) {
	const trimmed = String(value).trim();
	const finalValue = trimmed === '' ? DEFAULT_ORIGINAL_DELAY_MS : Number(trimmed);

	if (!Number.isFinite(finalValue) || !Number.isInteger(finalValue)) {
		return { isValid: false, message: '[Error] 다운로드 간격은 정수(ms)로 입력해야 합니다.' };
	}
	if (finalValue < 0 || finalValue > 10000) {
		return { isValid: false, message: '[Error] 다운로드 간격은 0~10000ms 사이여야 합니다.' };
	}
	return { isValid: true, value: finalValue, message: '원본 다운로드 간격이 저장되었습니다.' };
}

function displayDelaySaveResult(message, isSuccess) {
	delayFeedbackElement.style.color = isSuccess ? 'green' : 'red';
	delayFeedbackElement.innerHTML = `<div>${message}</div>`;
	delayInputElement.addEventListener('input', clearDelayFeedbackOnInput, { once: true });
}

function clearDelayFeedbackOnInput() {
	delayFeedbackElement.innerHTML = '';
}

function handleSave(pattern) {
	const finalPattern = pattern.trim() === '' ? DEFAULT_FILENAME_PATTERN : pattern;
	
	const result = validateFilenamePattern(finalPattern);
	
	if (result.isValid) {
		chrome.storage.sync.set({ [FILENAME_KEY]: finalPattern }, () => {
			displaySaveResult(finalPattern, '파일명 규칙이 저장되었습니다.', true);
		});
	} else {
		displaySaveResult(finalPattern, `${result.message}`, false);
	}
}

function handleDelaySave(value) {
	const result = validateDelayMs(value);

	if (result.isValid) {
		chrome.storage.sync.set({ [ORIGINAL_DELAY_KEY]: result.value }, () => {
			delayInputElement.value = String(result.value);
			displayDelaySaveResult(result.message, true);
		});
	} else {
		displayDelaySaveResult(result.message, false);
	}
}

function normalizeHttpUrl(value) {
	try {
		const parsed = new URL(String(value || '').trim());
		if (/^https?:$/i.test(parsed.protocol)) return parsed.href;
	} catch {
		return null;
	}
	return null;
}

function normalizeVersion(version) {
	return String(version || '').trim().replace(/^v/i, '');
}

function compareVersions(left, right) {
	const leftParts = normalizeVersion(left).split(/[.-]/);
	const rightParts = normalizeVersion(right).split(/[.-]/);
	const length = Math.max(leftParts.length, rightParts.length);

	for (let i = 0; i < length; i += 1) {
		const leftMatch = String(leftParts[i] || '0').match(/\d+/);
		const rightMatch = String(rightParts[i] || '0').match(/\d+/);
		const leftNum = leftMatch ? Number(leftMatch[0]) : 0;
		const rightNum = rightMatch ? Number(rightMatch[0]) : 0;
		if (leftNum > rightNum) return 1;
		if (leftNum < rightNum) return -1;
	}

	return 0;
}

function parseVersionJson(text) {
	const data = JSON.parse(text);
	const version = String(data.version || data.latest || '').trim();
	if (!version) throw new Error('version missing');
	return {
		version,
		url: normalizeHttpUrl(data.url || data.downloadUrl || data.releaseUrl) || DEFAULT_UPDATE_URL,
		message: String(data.message || '').trim()
	};
}

function parseVersionText(text) {
	const lines = String(text || '')
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean);
	const version = lines[0] || '';
	if (!version) throw new Error('version missing');
	return {
		version,
		url: normalizeHttpUrl(lines[1]) || DEFAULT_UPDATE_URL,
		message: lines.slice(2).join(' ')
	};
}

async function fetchLatestVersionInfo() {
	let lastError;

	for (const endpoint of VERSION_ENDPOINTS) {
		try {
			const response = await fetch(endpoint, { cache: 'no-store' });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const text = await response.text();
			return endpoint.endsWith('.json') ? parseVersionJson(text) : parseVersionText(text);
		} catch (error) {
			lastError = error;
		}
	}

	throw lastError || new Error('version check failed');
}

function openUpdateUrl(url) {
	const finalUrl = normalizeHttpUrl(url) || DEFAULT_UPDATE_URL;
	if (chrome.tabs?.create) {
		chrome.tabs.create({ url: finalUrl });
		return;
	}
	window.open(finalUrl, '_blank', 'noopener');
}

async function initializeVersionCheck() {
	versionStatusElement = document.getElementById('versionStatus');
	currentVersionElement = document.getElementById('currentVersion');
	updateButtonElement = document.getElementById('updateDownloadButton');

	if (!versionStatusElement || !currentVersionElement || !updateButtonElement) return;

	const currentVersion = chrome.runtime.getManifest().version;
	currentVersionElement.textContent = currentVersion;
	updateButtonElement.style.display = 'none';
	versionStatusElement.textContent = '버전 확인 중...';

	try {
		const latest = await fetchLatestVersionInfo();
		const hasUpdate = compareVersions(latest.version, currentVersion) > 0;

		if (hasUpdate) {
			versionStatusElement.textContent = latest.message
				? `신규 버전 ${latest.version}: ${latest.message}`
				: `신규 버전 ${latest.version}이 있습니다.`;
			updateButtonElement.style.display = 'inline-block';
			updateButtonElement.onclick = () => openUpdateUrl(latest.url);
			return;
		}

		versionStatusElement.textContent = '최신 버전입니다.';
	} catch (error) {
		versionStatusElement.textContent = '버전 정보를 확인할 수 없습니다.';
		console.warn('버전 확인 실패:', error);
	}
}

function loadAndInitializeAll() {
	inputElement = document.getElementById('filenamePatternInput');
	feedbackElement = document.getElementById('validationFeedback');
	delayInputElement = document.getElementById('originalDownloadDelayInput');
	delayFeedbackElement = document.getElementById('delayValidationFeedback');
	
	if (!inputElement || !feedbackElement || !delayInputElement || !delayFeedbackElement) {
		console.error("필수 DOM 요소를 찾을 수 없습니다.");
		return; 
	}

	const toggleDefaults = SETTINGS_CONFIG.keys.reduce((acc, key) => {
		acc[key] = SETTINGS_CONFIG.defaultValue;
		return acc;
	}, {});
	
	const allDefaults = {
		...toggleDefaults,
		[FILENAME_KEY]: DEFAULT_FILENAME_PATTERN,
		[ORIGINAL_DELAY_KEY]: DEFAULT_ORIGINAL_DELAY_MS
	};

	chrome.storage.sync.get(allDefaults, (data) => {
		SETTINGS_CONFIG.keys.forEach(key => {
			const toggle = document.getElementById(key);
			if (toggle) {
				toggle.checked = data[key];
				toggle.addEventListener('change', () => {
					chrome.storage.sync.set({ [key]: toggle.checked });
				});
			}
		});

		inputElement.value = data[FILENAME_KEY];
		delayInputElement.value = data[ORIGINAL_DELAY_KEY];

		inputElement.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				handleSave(inputElement.value);
			}
		});

		delayInputElement.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				handleDelaySave(delayInputElement.value);
			}
		});
	});

	initializeVersionCheck();
}

document.addEventListener('DOMContentLoaded', loadAndInitializeAll);
