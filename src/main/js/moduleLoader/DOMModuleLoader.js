
(function() {

  function getElements(className, el) {
    el = el || document;
    return el.querySelectorAll(className);
  }

  // find any scripted modules on the page
  function loadDOMModules() {
    let loader = new ModuleLoader();
    let modules = getElements('script[type=module]');
    modules.forEach(function(module) {
      let text = module.innerText;
      loader.registerScript(text);
    });
  }

  loadDOMModules();
})();
