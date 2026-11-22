// Single place to change the product name.
window.BRAND = { short: 'FFD', long: 'Fit For Deployment', tagline: 'Deployment readiness, confirmed.' };
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-brand]').forEach((el) => { el.textContent = window.BRAND[el.dataset.brand]; });
  document.title = document.title.replace('DRS', window.BRAND.short);
});
