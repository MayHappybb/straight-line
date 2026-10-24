// White or black paper, shared with mayhappybb.github.io: the site's pull-cord toggles the
// class "dark" on <html> and stores the choice in localStorage ('paper'). An inline script in
// index.html applies the saved choice before anything draws. White paper is the default, as on the site.
const root = document.documentElement;

export const isDark = () => root.classList.contains('dark');

/** Call fn whenever the paper changes. */
export function onThemeChange(fn) {
  new MutationObserver(() => fn(isDark())).observe(root, { attributes: true, attributeFilter: ['class'] });
}
