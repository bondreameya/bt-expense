/** Web app entry point. */
function doGet(e) {
  var t = HtmlService.createTemplateFromFile('index');
  t.appTitle = CONFIG.APP_TITLE;
  return t.evaluate()
    .setTitle(CONFIG.APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Template include helper: <?!= include('css') ?> */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}
