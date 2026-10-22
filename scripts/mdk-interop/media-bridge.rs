// Test-only bridge appended to a disposable MDK checkout's marmot-app lib.rs.
// Calls upstream upload/download implementations unchanged; no crypto mirror.
// Never compiled into the library being shipped.
#[doc(hidden)]
pub async fn marmot_ts_media_probe(
    request: serde_json::Value,
    media_secret: &[u8],
    source_epoch: u64,
) -> Result<serde_json::Value, String> {
    use media::*;
    let run = async {
        let allowed = vec!["blossom-v1".to_string()];
        let transport = media::BlossomHttpTransport::new(true);
        if request["op"] == "media_upload" {
            let keys = ::nostr::prelude::Keys::new(
                ::nostr::prelude::SecretKey::from_slice(&[7; 32]).unwrap(),
            );
            let result = media::upload_encrypted_media(
                MediaUploadRequest {
                    attachments: vec![MediaUploadAttachmentRequest {
                        file_name: "café.txt".into(),
                        media_type: "text/plain".into(),
                        plaintext: b"Rust media v2 payload".to_vec(),
                        dim: None,
                        thumbhash: None,
                    }],
                    caption: None,
                    send: false,
                    blossom_server: Some(request["server"].as_str().unwrap().into()),
                    message_tags: vec![],
                },
                source_epoch,
                media_secret,
                &keys,
                media::MediaOperationPolicy {
                    version: EncryptedMediaVersion::V2,
                    default_endpoints: &[],
                    allowed_locator_kinds: &allowed,
                    allow_loopback_http: true,
                },
                &transport,
            )
            .await?;
            let reference = &result.attachments[0].reference;
            let tag = reference.build_imeta_tag(EncryptedMediaVersion::V2, &allowed, true)?;
            Ok::<_, AppError>(serde_json::json!({"tag": tag}))
        } else {
            let tag: Vec<String> = serde_json::from_value(request["tag"].clone()).unwrap();
            let reference = parse_media_attachment(&tag, Some(source_epoch), true)?;
            let result = media::download_encrypted_media_with_transport(
                reference,
                media_secret,
                &[],
                &allowed,
                &transport,
                None,
            )
            .await?;
            Ok(
                serde_json::json!({"plaintext": hex::encode(result.plaintext),
                "filename": result.file_name, "media_type": result.media_type}),
            )
        }
    };
    run.await.map_err(|e| e.to_string())
}
