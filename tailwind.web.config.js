// Tailwind for the public website (web/), compiled ahead of time into
// web/tailwind.css by `npm run build:web-css`.
//
// The site used to load the Tailwind Play CDN, which downloads a compiler and
// builds the styles in every visitor's browser; on mobile that delayed the
// first content by seconds. This is the same Tailwind (3.4.17, the version the
// CDN served) with the same default theme, so the generated rules match.
//
// Classes are found by scanning these files as text, including the inline
// scripts and the translation dictionaries in the pages. A class assembled
// from pieces at runtime would be missed: write class names in full.

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./web/**/*.html']
};
