'use strict';

// Plantilla del menú de aplicación.
//
// Por qué existe: la barra File/Edit/View/Window/Help por defecto de Electron no
// aporta nada en MIKA5 y ocupa una franja en Windows y Linux. Quitarla con
// `Menu.setApplicationMenu(null)` es peor: se pierden los aceleradores de
// edición (Ctrl+C/V/X/A, deshacer, rehacer) porque en Chromium los provee el
// menú. Aquí se registra un menú real con roles nativos y, fuera de macOS, se
// oculta la barra sin desactivar los atajos.
//
// El módulo es puro: no importa `electron`, no toca ventanas y no ejecuta nada
// al requerirse, para poder probar la plantilla sin arrancar la aplicación.

/**
 * @param {{ platform?: string, isDevelopment?: boolean }} opciones
 * @returns {Array} plantilla para Menu.buildFromTemplate
 */
function buildApplicationMenuTemplate({ platform = process.platform, isDevelopment = false } = {}) {
  const esMac = platform === 'darwin';
  const plantilla = [];

  // macOS conserva su menú de aplicación: sin él no hay Cmd+Q ni Cmd+H.
  if (esMac) {
    plantilla.push({
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  // Edición: la razón por la que el menú sigue existiendo en todas las
  // plataformas. Sólo roles nativos, nada sin implementación real detrás.
  plantilla.push({
    role: 'editMenu',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(esMac ? [{ role: 'pasteAndMatchStyle' }] : []),
      { role: 'delete' },
      { role: 'selectAll' }
    ]
  });

  // Recarga y devtools sólo en desarrollo: la política de producción no expone
  // herramientas de depuración.
  const vista = [
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' }
  ];
  if (isDevelopment) {
    vista.unshift({ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' });
  }
  plantilla.push({ role: 'viewMenu', submenu: vista });

  plantilla.push({
    role: 'windowMenu',
    submenu: esMac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'close' }]
  });

  return plantilla;
}

/** Fuera de macOS la barra se oculta; en macOS vive en la barra global del sistema. */
function shouldHideMenuBar(platform = process.platform) {
  return platform !== 'darwin';
}

module.exports = { buildApplicationMenuTemplate, shouldHideMenuBar };
