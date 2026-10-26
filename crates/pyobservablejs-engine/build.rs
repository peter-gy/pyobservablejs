use std::{
    env, error::Error, fmt::Write as _, fs, io::Write as _, path::Path, path::PathBuf,
    process::Command,
};

const WEB_CRATES: [&str; 2] = ["deno_web", "deno_webidl"];

/// deno_core records extension JavaScript by its path in the Cargo registry.
/// Embed those sources so the extension module runs on machines without it.
fn web_sources(out_dir: &Path) -> Result<(), Box<dyn Error>> {
    let output = Command::new(env::var("CARGO")?)
        .args(["metadata", "--format-version", "1", "--locked", "--offline"])
        .args(["--filter-platform", &env::var("TARGET")?])
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "cargo metadata failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    let metadata: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    let packages = metadata["packages"]
        .as_array()
        .ok_or("cargo metadata lists no packages")?;
    let mut entries = String::new();
    for name in WEB_CRATES {
        let package = packages
            .iter()
            .find(|package| package["name"] == name)
            .ok_or_else(|| format!("Missing web extension crate {name}"))?;
        let root = PathBuf::from(
            package["manifest_path"]
                .as_str()
                .ok_or("Missing extension manifest path")?,
        );
        let root = root.parent().ok_or("Invalid extension manifest path")?;
        let mut files = fs::read_dir(root)?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<Result<Vec<_>, _>>()?;
        files.retain(|path| path.extension().is_some_and(|extension| extension == "js"));
        files.sort();
        for path in files {
            let file = path
                .file_name()
                .and_then(|file| file.to_str())
                .ok_or("Invalid extension source name")?;
            writeln!(
                entries,
                "deno_core::ExtensionFileSource::new({:?}, deno_core::ascii_str_include!({:?})),",
                format!("ext:{name}/{file}"),
                path.display().to_string(),
            )?;
        }
    }
    fs::write(
        out_dir.join("web_sources.rs"),
        format!("pub const SOURCES: &[deno_core::ExtensionFileSource] = &[\n{entries}];\n"),
    )?;
    Ok(())
}

/// Embed the engine bundle's entry and lazy chunks under their file names.
/// `@pyobservablejs/engine` writes them to `bundle/`.
fn engine_modules(out_dir: &Path) -> Result<(), Box<dyn Error>> {
    let root = Path::new("bundle");
    writeln!(
        std::io::stdout(),
        "cargo:rerun-if-changed={}",
        root.display()
    )?;
    let mut files = fs::read_dir(root)
        .map_err(|error| {
            format!(
                "Missing notebook engine bundle in {}: {error}. Run pnpm build first.",
                root.display()
            )
        })?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    files.retain(|path| path.extension().is_some_and(|extension| extension == "js"));
    files.sort();
    if !files.iter().any(|path| path.ends_with("engine.js")) {
        return Err("Missing notebook engine entry bundle/engine.js. Run pnpm build first.".into());
    }
    let mut entries = String::new();
    for path in files {
        writeln!(
            std::io::stdout(),
            "cargo:rerun-if-changed={}",
            path.display()
        )?;
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid engine module name")?;
        let absolute = fs::canonicalize(&path)?;
        writeln!(
            entries,
            "({name:?}, include_str!({:?})),",
            absolute.display().to_string()
        )?;
    }
    fs::write(
        out_dir.join("engine_modules.rs"),
        format!("pub const MODULES: &[(&str, &str)] = &[\n{entries}];\n"),
    )?;
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let out_dir = PathBuf::from(env::var("OUT_DIR")?);
    writeln!(std::io::stdout(), "cargo:rerun-if-changed=Cargo.lock")?;
    engine_modules(&out_dir)?;
    web_sources(&out_dir)
}
