pub mod folders;
pub mod handler;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    // File upload: canonical POST /api/files, legacy POST /api/files/upload.
    cfg.route("/files", web::post().to(handler::upload_file))
        .route("/files/upload", web::post().to(handler::upload_file))
        .service(handler::get_files)
        .service(handler::download_file)
        .service(folders::create_folder)
        .service(folders::list_folders)
        .service(folders::delete_folder);
}
