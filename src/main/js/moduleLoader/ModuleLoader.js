(function(root, fetch) {
  if (typeof exports === 'undefined') {
    exports = root;
  }
  const ENABLE_LOGGING = false;

  const STATE_NEW = 'new';
  const STATE_FETCHING = 'fetching';
  const STATE_PENDING = 'pending';
  const STATE_INITIALIZED = 'initialized';

  function log() {
    if (ENABLE_LOGGING) {
      console.log.apply(console, arguments);
    }
  }

  function warn() {
    console.warn.apply(console, arguments);
  }

  const parseModule = function(script, sourceModulePath) {

    // add script details
    script = '// Module src: ' + sourceModulePath + "\n" + script;

    // find imports
    let importRegex = new RegExp('import ((\{[^\}]+\}|[A-Za-z0-9\$_]+) from )?["\']{1}([^ \r\n\'"]+)["\']{1}', 'g');
    let importNamesRegex = new RegExp('\{|,|\}', 'g');
    let deps = [];
    let moduleScript = script.replace(importRegex, function() {
      let importNames = arguments[2];
      let importPath = arguments[3];
      let dep = {
        importPath
      };
      if (importNames.startsWith('{')) {

        // named imports requested
        dep.importNames = importNames.split(importNamesRegex).filter(function(s) {
          return s !== '';
        });
      } else {
        dep.importName = importNames;
      }
      deps.push(dep);
      return '';
    });

    // find exports
    let exportRegex = new RegExp('export (default )?(.+)\n', 'gi');
    let exportClassRegex = new RegExp('(function\s*|class\s*)([^\(\{]+)');
    let exportVariableRegex = new RegExp('(var\s*)([^\=]+)');
    let exportClassNameRegex = new RegExp('(.+) extends');
    let exportItems = [];
    moduleScript = moduleScript.replace(exportRegex, function() {

      // parse the export name
      let exportLine = arguments[2];
      let nameMatches = exportLine.match(exportClassRegex);
      let exportName;
      if (!nameMatches) {
        exportName = 'MODULE_DEFAULTS';
        let variableMatches = exportLine.match(exportVariableRegex);
        if (variableMatches) {
          exportName = variableMatches[2].trim();
        } else {
          warn('Exports might not be working for line:', exportLine);
          exportLine = 'let MODULE_DEFAULTS = ' + exportLine;
        }
      } else {
        exportName = nameMatches[2].trim();
      }
      if (exportName.indexOf('extends') !== -1) {

        // need to parse out the class name
        nameMatches = exportName.match(exportClassNameRegex);
        exportName = nameMatches[1];
      }
      exportItems.push(`module.exports.${exportName} = ${exportName};`);
      return exportLine + "\n";
    });

    // append the exports
    moduleScript = moduleScript + "\n" + exportItems.join("\n");
    modulePath = null;
    return {
      modulePath,
      deps,
      moduleScript
    };
  };

  class ModuleLoader {
    /*static plugins = {};*/

    static addPlugin(type, plugin) {
      let t = ModuleLoader.plugins[type] = ModuleLoader.plugins[type] || [];
      t.push(plugin);
    }

    constructor() {
      let modules = [];

      const has = function(deps) {
        let hasAll = true;
        deps.forEach(function(dep) {
          let module = getModule(dep.path);
          if (!module || module.state !== STATE_INITIALIZED) {
            hasAll = false;
          }
        });
        return hasAll;
      };

      const getModule = function(path) {
        return modules.find(function(module) {
          return module.path === path;
        });
      };

      const computeModulePath = function(modulePath, parentPath) {
        if (parentPath && modulePath.startsWith('.')) {
          let basenameSplit = parentPath.split('/');
          basenameSplit.pop();
          modulePath = basenameSplit.join('/') + modulePath.substring(1);
        }
        let pathPlugins = ModuleLoader.plugins['path'] || [];
        pathPlugins.forEach((plugin) => {
          modulePath = plugin(modulePath);
        });
        return modulePath;
      };

      this.registerScript = (script) => {
        let parsed = parseModule(script);
        parsed.deps.forEach((dep) => {
          dep.path = computeModulePath(dep.importPath);
        });
        this.registerModule(parsed.modulePath, parsed.deps, parsed.moduleScript);
      };

      this.registerModule = (modulePath, deps, script) => {
        let module = getModule(modulePath);
        if (!module) {
          module = {
            injectable: modulePath !== null,
            state: STATE_NEW,
            path: modulePath
          };
          modules.push(module);
        }
        if (deps && script) {
          Object.assign(module, {
            state: STATE_PENDING,
            deps,
            script
          });
          onLoadModule();
        } else {

          // need to request the module
          let fullPath = modulePath;
          let extension = fullPath.substr(fullPath.lastIndexOf('.')+1);
          if (extension !== 'js') {
            fullPath += '.js';
          }
          log('Requesting module:', fullPath);
          if (module.state !== STATE_NEW) {
            throw 'Module already requested!';
          }
          module.state = STATE_FETCHING;
          if (!fullPath) {
            throw 'Cannot load module without path';
          }
          fetch(fullPath).then(function(response) {
            return response.text();
          }).then((text) => {
            let parsed = parseModule(text, modulePath);
            parsed.deps.forEach((dep) => {
              dep.path = computeModulePath(dep.importPath, modulePath);
            });
            this.registerModule(modulePath, parsed.deps, parsed.moduleScript);
          });
        }
      };

      const onLoadModule = function() {
        modules.forEach(function(module) {
          if (module.state === STATE_PENDING) {
            if (has(module.deps)) {
              initializeModule(module);
            } else {
              loadDependencies(module.deps);
            }
          }
        });
      };

      const loadDependencies = (deps) => {
        deps.forEach((dep) => {
          let module = getModule(dep.path);
          if (!module) {

            // request the dependency
            this.registerModule(dep.path);
          }
        });
      };

      const initializeModule = function(module) {
        log('Initializing module:', module.path);

        // wrap it up
        (function() {
          let definedExports = {};
          let moduleExports = {
            exports: definedExports
          };
          let moduleDeps = {};
          module.deps.forEach(function(dep) {
            let depExports = getModule(dep.path).exports;
            if (dep.importName) {

              // whole module import
              moduleDeps[dep.importName] = depExports;
            } else {

              // multiple imports
              dep.importNames.forEach(function(name) {
                moduleDeps[name] = depExports[name];
              });
            }
          });
          moduleDeps['module'] = moduleExports;
          moduleDeps['exports'] = definedExports;

          let modulePath = module.path;
          let loaderApi = {
            computeModulePath,
            getModule
          };
          let depPlugins = ModuleLoader.plugins['deps'] || [];
          depPlugins.forEach(function(loader) {
            loader(loaderApi, modulePath, moduleDeps);
          });
          let moduleWrapper = new Function(Object.keys(moduleDeps), module.script);
          moduleWrapper.apply(moduleWrapper, Object.values(moduleDeps));
          let exported = moduleExports.exports;
          if (module.path !== null && (!exported || Object.keys(exported).length === 0)) {
            warn('Module has no exports:' + module.path);
          }
          module.exports = moduleExports.exports;
        })();

        module.state = STATE_INITIALIZED;
        onLoadModule();
      };
    }
  }

  ModuleLoader.plugins = {};

  exports.ModuleLoader = ModuleLoader;

})(window, fetch);
