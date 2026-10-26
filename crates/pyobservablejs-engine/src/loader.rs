use deno_core::{
    ModuleLoadOptions, ModuleLoadReferrer, ModuleLoadResponse, ModuleLoader, ModuleSource,
    ModuleSourceCode, ModuleSpecifier, ModuleType, RequestedModuleType, ResolutionKind,
    error::ModuleLoaderError, resolve_import,
};
use deno_error::JsErrorBox;
use std::sync::Arc;

use crate::{
    cache::ModuleCache,
    network::{self, Network},
};

mod engine {
    include!(concat!(env!("OUT_DIR"), "/engine_modules.rs"));
}

/// Scheme of the engine bundle's embedded modules.
pub const ENGINE_SCHEME: &str = "pyobservablejs";

/// Load the embedded engine modules, and notebook imports from `data:` and
/// HTTP(S) URLs under the engine's network policy.
pub struct Loader {
    pub network: Arc<Network>,
    pub cache: Arc<ModuleCache>,
}

impl ModuleLoader for Loader {
    fn resolve(
        &self,
        specifier: &str,
        referrer: &str,
        _kind: ResolutionKind,
    ) -> Result<ModuleSpecifier, ModuleLoaderError> {
        resolve_import(specifier, referrer).map_err(JsErrorBox::from_err)
    }

    fn load(
        &self,
        specifier: &ModuleSpecifier,
        _referrer: Option<&ModuleLoadReferrer>,
        options: ModuleLoadOptions,
    ) -> ModuleLoadResponse {
        let module_type = match options.requested_module_type {
            RequestedModuleType::Json => ModuleType::Json,
            _ => ModuleType::JavaScript,
        };
        if specifier.scheme() == ENGINE_SCHEME {
            let path = specifier.path().trim_start_matches('/');
            return ModuleLoadResponse::Sync(
                engine::MODULES
                    .iter()
                    .find(|(name, _)| *name == path)
                    .map(|(_, source)| {
                        ModuleSource::new(
                            module_type,
                            ModuleSourceCode::String((*source).to_owned().into()),
                            specifier,
                            None,
                        )
                    })
                    .ok_or_else(|| {
                        JsErrorBox::type_error(format!("Unknown engine module: {specifier}"))
                    }),
            );
        }
        let (network, cache) = (self.network.clone(), self.cache.clone());
        let specifier = specifier.clone();
        ModuleLoadResponse::Async(Box::pin(async move {
            let module = network::module(network, cache, specifier.clone()).await?;
            Ok(ModuleSource::new_with_redirect(
                module_type,
                ModuleSourceCode::String(module.source.clone().into()),
                &specifier,
                &module.url,
                None,
            ))
        }))
    }
}
