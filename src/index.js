const path = require('path'),
  pug = require('pug'),
  walk = require('pug-walk');

const { merge } = require('webpack-merge');
const parseResourceData = require('./utils/parse');

// variables with global scope in this module
let webpackResolveAlias = {};
let loaderMethod = null;

/**
 * @param {string} match The matched alias.
 * @return {string} The regex pattern with matched aliases.
 */
const regexpAlias = (match) => `^[~@]?(${match})(?=\\/)`;

/**
 * Replace founded alias in require argument.
 *
 * @param {string} value The resource value include require('').
 * @param {{}} aliases The `resolve.alias` of webpack config.
 * @param {function(string):string} regexp The function return a regex pattern string. The argument is alias name.
 * @return {string} The string with replaced alias.
 */
const resolveAlias = (value, aliases, regexp) => {
  let result = value;
  const patternAliases = Object.keys(aliases).join('|');

  if (!patternAliases) return result;

  const aliasMatch = new RegExp(regexp(patternAliases)).exec(value);
  if (aliasMatch) {
    const alias = aliasMatch[1];
    result = value.replace(new RegExp(regexp(alias)), aliases[alias]).replace('//', '/');
  }

  return result;
};

/**
 * Resolve a path in the argument of require() function.
 *
 * @param {string} value The resource value include require().
 * @param {string} templateFile
 * @param {{}} aliases The resolve.alias from webpack config.
 * @param {LoaderMethod} method The object of the current method.
 * @return {string|null}
 */
const resolveResourcePath = function (value, templateFile, aliases, method) {
  // match an argument of require(resourcePath)
  let [, resourcePath] = /(?<=require\()(.+)(?=\))/.exec(value);
  if (!resourcePath) return value;

  // 1. delete `./` from path, because at begin will be added full path like `/path/to/current/dir/`
  resourcePath = resourcePath.replace(/(?<=[^\.])(\.\/)/, '');

  // 2. replace alias with absolute path
  let resolvedPath = resolveAlias(resourcePath, aliases, (match) => `(?<=["'\`])(${match})(?=\/)`);

  // 3. if the alias is not found in the path,
  // then add the absolute path of the current template at the beginning of the argument,
  // e.g. like this require('/path/to/template/' + 'filename.jpeg')
  if (resolvedPath === resourcePath) {
    // 4. if an argument of require() begin with a relative parent path as the string template with a variable,
    // like require(`../images/${file}`), then extract the relative path to the separate string
    if (resourcePath.indexOf('`../') === 0) {
      const relPathRegex = /(?<=`)(.+)(?=\$\{)/;
      const relPathMatches = relPathRegex.exec(value);
      if (relPathMatches) {
        resourcePath = `'${relPathMatches[1]}' + ` + resourcePath.replace(relPathRegex, '');
      }
    }
    resolvedPath = `'${path.dirname(templateFile)}/' + ${resourcePath}`;
  }

  return method.require(resolvedPath);
};

/**
 * Merge the template variable `locals` in the code `var locals_for_with = (locals || {});`
 * with a data from resource query and loader options, to allow pass a data into template at compile time, e.g.:
 * `const html = require('template.pug?{"a":10,"b":"abc"}');`
 *
 * @param {string} funcBody The function as string.
 * @param {{}} locals The object of template variables.
 * @return {string}
 */
const mergedTemplateVariables = (funcBody, locals) =>
  funcBody.replace(
    /(?<=locals_for_with = )(?:\(locals \|\| {}\))(?=;)/,
    'Object.assign(' + JSON.stringify(locals) + ', locals)'
  );

/**
 * Get data from the resource query.
 *
 * @param {string} str
 * @return {{}}
 */
const getResourceParams = function (str) {
  if (str[0] !== '?') return {};
  const query = str.substr(1);

  return parseResourceData(query);
};

/**
 * Pug plugin to resolve path for include, extend, require.
 *
 * @type {{preLoad: (function(*): *)}}
 */
const resolvePlugin = {
  preLoad: (ast) =>
    walk(ast, (node) => {
      if (node.type === 'FileReference') {
        let result = resolveAlias(node.path, webpackResolveAlias, regexpAlias);
        if (result && result !== node.path) node.path = result;
      } else if (node.attrs) {
        node.attrs.forEach((attr) => {
          if (attr.val && typeof attr.val === 'string' && attr.val.indexOf('require(') === 0) {
            let result = resolveResourcePath(attr.val, attr.filename, webpackResolveAlias, loaderMethod);
            if (result && result !== attr.val) attr.val = result;
          }
        });
      }
    }),
};

/**
 * @typedef LoaderMethod
 * @property {string} method The compiler export method, defined in loader option.
 * @property {string} queryParam The same as `method`, but defined in resource query parameter.
 * @property {function(string)} getLocals Get template variables. Here can be merged additional custom properties.
 * @property {function(string, string, {})} export The export method of compiled template function.
 * @property {function(string)} require The inject require.
 */

/**
 * Loader methods to export template function.
 *
 * @type {LoaderMethod[]}
 */
const loaderMethods = [
  {
    // export the compiled template function
    method: 'compile',
    queryParam: 'pug-compile',
    getLocals: (locals) => locals,
    require: (file) => `require(${file})`,
    export: (funcBody, name, locals) => funcBody + ';module.exports=' + name + ';',
  },
  {
    // export rendered HTML string at compile time
    method: 'render',
    queryParam: 'pug-render',
    getLocals: (locals) => ({
      ...locals,
      ...{ __asset_resource_require__: (file) => `' + __asset_resource_require__(\`${file}\`) + '` },
    }),
    require: (file) => `locals.__asset_resource_require__(${file})`,
    export: (funcBody, name, locals) =>
      ("module.exports='" + new Function('', funcBody + ';return ' + name + '')()(locals) + "'").replaceAll(
        '__asset_resource_require__',
        'require'
      ),
  },
  {
    // export the compiled template function, by require() it will be auto rendered into HTML string at runtime
    // @deprecated, it is reserved only as rescue fallback, after stable release of method `render` will be removed
    method: 'rtRender',
    queryParam: 'pug-rtrender',
    getLocals: (locals) => locals,
    require: (file) => `require(${file})`,
    export: (funcBody, name, locals) => funcBody + ';module.exports=' + name + '();',
  },
  {
    // render to pure HTML string at compile time
    // note: this method should be used with additional loader to handle HTML
    method: 'html',
    queryParam: null,
    getLocals: (locals) => locals,
    require: (file) => `(${file})`,
    export: (funcBody, name, locals) => new Function('', funcBody + ';return ' + name + '')()(locals),
  },
];

/**
 * @param {string} content The pug template.
 * @param {function(error: string|null, result: string?)?} callback The asynchronous callback function.
 * @return {string|undefined}
 */
const compilePugContent = function (content, callback) {
  let res = {};
  const loaderContext = this,
    filename = loaderContext.resourcePath,
    loaderOptions = loaderContext.getOptions() || {},
    data = getResourceParams(loaderContext.resourceQuery),
    // the rule: a method defined in the resource query has highest priority over a method defined in the loader options
    // because a method from loader options is global but a query method override by local usage a global method
    methodFromQuery = loaderMethods.find((item) => data.hasOwnProperty(item.queryParam)),
    methodFromOptions = loaderMethods.find((item) => loaderOptions.method === item.method);

  // define the `loaderMethod` for global scope in this module
  loaderMethod = methodFromQuery || methodFromOptions || loaderMethods[0];

  // pug compiler options
  const options = {
    // used to resolve imports/extends and to improve errors
    filename: filename,
    // The root directory of all absolute inclusion. Defaults is /.
    //basedir: basedir,
    basedir: '/',
    doctype: loaderOptions.doctype || 'html',
    /** @deprecated This option is deprecated and must be false, see https://pugjs.org/api/reference.html#options */
    pretty: false,
    filters: loaderOptions.filters,
    self: loaderOptions.self || false,
    // Output compiled function to stdout. Must be false.
    debug: false,
    // Include the function source in the compiled template. Defaults is false.
    compileDebug: loaderOptions.debug || false,
    globals: ['require', ...(loaderOptions.globals || [])],
    // Load all requires as function. Must be true.
    inlineRuntimeFunctions: true,
    //inlineRuntimeFunctions: false,
    // default name of template function is `template`
    name: loaderOptions.name || 'template',
    // the template without export module syntax, because the export will be determined depending on the method
    module: false,
    plugins: [resolvePlugin, ...(loaderOptions.plugins || [])],
  };

  loaderContext.cacheable && loaderContext.cacheable(true);

  try {
    /** @type {{body: string, dependencies: []}} */
    res = pug.compileClientWithDependenciesTracked(content, options);
  } catch (exception) {
    // show original error
    console.log('[pug compiler error] ', exception);
    // watch files in which an error occurred
    if (exception.filename) loaderContext.addDependency(path.normalize(exception.filename));
    callback(exception);
    return;
  }

  // add dependency files to watch changes
  if (res.dependencies.length) res.dependencies.forEach(loaderContext.addDependency);

  // remove pug method from query data to pass only clean data w/o meta params
  delete data[loaderMethod.queryParam];

  const locals = loaderMethod.getLocals(merge(loaderOptions.data || {}, data)),
    funcBody = Object.keys(locals).length ? mergedTemplateVariables(res.body, locals) : res.body,
    output = loaderMethod.export(funcBody, options.name, locals);

  callback(null, output);
};

// Asynchronous Loader, see https://webpack.js.org/api/loaders/#asynchronous-loaders
module.exports = function (content, map, meta) {
  const callback = this.async();

  // save resolve.alias from webpack config for global scope in this module,
  // see https://webpack.js.org/api/loaders/#this_compiler
  webpackResolveAlias = this._compiler.options.resolve.alias || {};

  compilePugContent.call(this, content, (err, result) => {
    if (err) return callback(err);
    callback(null, result, map, meta);
  });
};

// exports for test
module.exports.getResourceParams = getResourceParams;
module.exports.regexpAlias = regexpAlias;
module.exports.resolveAlias = resolveAlias;
module.exports.resolveResourcePath = resolveResourcePath;
module.exports.loaderMethods = loaderMethods;
