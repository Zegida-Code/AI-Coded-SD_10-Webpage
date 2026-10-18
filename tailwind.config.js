/** Tailwind config for the SD-10 Web Console. Build with ./build-css.sh */
module.exports = {
  content: ['./index.html', './js/**/*.js'],
  darkMode: 'media',
  // class names assembled at runtime (js/app.js valueRow: 'col-span-' + span)
  safelist: ['col-span-2', 'col-span-4'],
  theme: { extend: {} },
  plugins: [],
};
