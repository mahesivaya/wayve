pub mod folders;
pub mod handler;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handler::upload_file)
        .service(handler::get_files)
        .service(handler::download_file)
        .service(handler::shared_drive_items)
        .service(handler::share_file)
        .service(handler::share_folder)
        .service(handler::download_shared_file)
        .service(folders::create_folder)
        .service(folders::list_folders)
        .service(folders::delete_folder);
}
