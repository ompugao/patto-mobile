// Patto Mobile - Tauri 2.0 Application
// A mobile app for viewing and editing patto notes

mod commands;
mod image_proxy;
mod renderer;

use tauri::Manager;

use commands::files::{create_file, delete_file, get_file_info, list_files, rename_file};
use commands::git::{configure_remote, git_clone, git_init, git_pull, git_status, git_sync};
use commands::notes::{extract_links, read_note, render_content, render_note, write_note};
use commands::tasks::{get_all_tasks, get_file_tasks, get_task_summary};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        // Local images: `pimg://localhost/<path>` (http://pimg.localhost/ on Android/Windows)
        .register_asynchronous_uri_scheme_protocol(image_proxy::SCHEME, image_proxy::handle)
        .setup(|app| {
            let cache_dir = app.path().app_cache_dir()?.join("img");
            let proxy = image_proxy::ImageProxy::new(cache_dir);
            let pruner = proxy.clone();
            tauri::async_runtime::spawn_blocking(move || pruner.prune_cache());
            app.manage(proxy);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Git commands
            git_clone,
            git_pull,
            git_sync,
            git_init,
            git_status,
            configure_remote,
            // File commands
            list_files,
            get_file_info,
            create_file,
            delete_file,
            rename_file,
            // Note commands
            read_note,
            write_note,
            render_note,
            render_content,
            extract_links,
            // Task commands
            get_all_tasks,
            get_file_tasks,
            get_task_summary,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
