// Minimal stubs for untyped vendored modules.
declare module "foliate-js/view.js";
declare module "foliate-js/mobi.js" {
  export const isMOBI: (file: Blob) => Promise<boolean>;
  export const MOBI: any;
}
declare module "foliate-js/vendor/fflate.js" {
  export const unzlibSync: (data: Uint8Array) => Uint8Array;
}
