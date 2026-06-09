pub mod handler;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/documents", web::post().to(handler::upload_documents))
        .service(handler::list_documents)
        .service(handler::download_document)
        .service(handler::rename_document)
        .service(handler::delete_document)
        .service(handler::list_folders)
        .service(handler::create_folder)
        .service(handler::rename_folder)
        .service(handler::delete_folder);
}
