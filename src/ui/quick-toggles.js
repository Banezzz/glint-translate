// Theme and interface-language buttons for the popup header and the
// settings page. Both save to settings; every open page, the card and the
// floating ball follow through storage change events.
import { updateSettings } from '../shared/settings.js';
import { getLocale, t } from './i18n.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const THEMES = ['auto', 'light', 'dark'];
const THEME_ICONS = {
  auto: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z', 'M12 18a6 6 0 0 0 0-12v12z'],
  light: [
    'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z',
    'M12 2v2', 'M12 20v2', 'm4.93 4.93 1.41 1.41', 'm17.66 17.66 1.41 1.41',
    'M2 12h2', 'M20 12h2', 'm6.34 17.66-1.41 1.41', 'm19.07 4.93-1.41 1.41',
  ],
  dark: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z'],
};
const LANGUAGE_NAMES = { 'zh-CN': '简体中文', en: 'English' };

function themeIcon(theme) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of THEME_ICONS[theme]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * Wires a theme button (cycles system → light → dark) and a language button
 * (switches between Chinese and English). getSettings returns the current
 * settings; call the returned render() after settings change elsewhere.
 */
export function initQuickToggles({ themeButton, languageButton, getSettings }) {
  function render() {
    const { theme } = getSettings();
    const current = THEMES.includes(theme) ? theme : 'auto';
    themeButton.replaceChildren(themeIcon(current));
    themeButton.dataset.theme = current;
    themeButton.title = t('quick.theme', { name: t(`theme.${current}`) });
    themeButton.setAttribute('aria-label', themeButton.title);

    const locale = getLocale();
    for (const part of languageButton.querySelectorAll('[data-locale]')) part.classList.toggle('on', part.dataset.locale === locale);
    languageButton.title = t('quick.language', { name: LANGUAGE_NAMES[locale] });
    languageButton.setAttribute('aria-label', languageButton.title);
  }

  themeButton.addEventListener('click', () => {
    const { theme } = getSettings();
    const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    updateSettings({ theme: next });
  });
  languageButton.addEventListener('click', () => {
    updateSettings({ uiLang: getLocale() === 'en' ? 'zh-CN' : 'en' });
  });
  render();
  return render;
}
