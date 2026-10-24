// Execute the installed Wrangler serializer and config-binding converter, with
// no CLI invocation, upload, credentials, transport or copied serializer logic.
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
let actualWrangler;
export function wranglerUploadMetadata(
  config,
  { content = "export default {};", assetsOnly = !config.main } = {},
) {
  if (!actualWrangler) {
    const filename = require.resolve("wrangler"),
      source = fs.readFileSync(filename, "utf8");
    for (const name of [
      "createWorkerUploadForm",
      "getBindings",
      "init_create_worker_upload_form",
      "init_binding_utils",
    ])
      if (!source.includes(name))
        throw Error("installed_wrangler_serializer_changed");
    const loaded = new Module(filename);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(
      source +
        "\nexports.shelfMetadata=(worker,config)=>{init_binding_utils();init_create_worker_upload_form();return createWorkerUploadForm(worker,getBindings(config));};\n",
      filename,
    );
    actualWrangler = loaded.exports.shelfMetadata;
  }
  const worker = {
    main: { name: "shelf-main.mjs", type: "esm", content },
    modules: [],
    compatibility_date: config.compatibility_date,
    keepSecrets: true,
    keepVars: false,
    assets: config.assets
      ? {
          jwt: "synthetic-assets-upload-jwt",
          routerConfig: { has_user_worker: !assetsOnly },
          assetConfig: {
            html_handling: config.assets.html_handling,
            not_found_handling: config.assets.not_found_handling,
          },
        }
      : undefined,
  };
  return JSON.parse(actualWrangler(worker, config).get("metadata"));
}
