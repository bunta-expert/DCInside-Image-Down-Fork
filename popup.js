const SETTINGS_CONFIG = {
	keys: ["ElementMove", "IgnoreAttachment", "DebugMode"],
	defaultValue: false
};
const FILENAME_KEY = 'filenamePattern';
const DEFAULT_FILENAME_PATTERN = '?title';
const ALLOWED_KEYWORDS = ['title', 'id', 'gall', 'today', 'wday'];
const REQUIRED_KEYWORD = '?title';
let inputElement;
let feedbackElement; 

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

function loadAndInitializeAll() {
	inputElement = document.getElementById('filenamePatternInput');
	feedbackElement = document.getElementById('validationFeedback');
	
	if (!inputElement || !feedbackElement) {
		console.error("필수 DOM 요소를 찾을 수 없습니다.");
		return; 
	}

	const toggleDefaults = SETTINGS_CONFIG.keys.reduce((acc, key) => {
		acc[key] = SETTINGS_CONFIG.defaultValue;
		return acc;
	}, {});
	
	const allDefaults = {
		...toggleDefaults,
		[FILENAME_KEY]: DEFAULT_FILENAME_PATTERN
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

		inputElement.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				handleSave(inputElement.value);
			}
		});
	});
}

document.addEventListener('DOMContentLoaded', loadAndInitializeAll);
