use async_trait::async_trait;
use cgka_engine::{
    EngineBuilder,
    account_identity_proof::{AccountIdentityProofRequest, AccountIdentityProofSigner},
};
use cgka_traits::{
    engine::{CgkaEngine, CreateGroupRequest, KeyPackage, SendResult},
    error::PeelerError,
    group::ProtocolProfile,
    group_context::GroupContextSnapshot,
    ingest::{PeeledContent, PeeledMessage},
    peeler::TransportPeeler,
    transport::{
        EncryptedPayload, Timestamp, TransportEnvelope, TransportMessage, TransportSource,
    },
    types::{MemberId, MessageId},
};
use k256::schnorr::{SigningKey, signature::hazmat::PrehashSigner};
use nostr::prelude::{Event, FinalizeEvent, Keys, PublicKey, SecretKey, UnsignedEvent};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{self, BufRead, Write},
    sync::Arc,
};
use storage_sqlite::SqliteAccountStorage;
struct Signer(SigningKey);
impl AccountIdentityProofSigner for Signer {
    fn sign_account_identity_proof(
        &self,
        r: &AccountIdentityProofRequest,
    ) -> Result<[u8; 64], String> {
        let s: k256::schnorr::Signature = self
            .0
            .sign_prehash(&r.proof_event_id()?)
            .map_err(|e| e.to_string())?;
        Ok(s.to_bytes())
    }
}
struct RawPeeler;
fn message(bytes: Vec<u8>, envelope: TransportEnvelope) -> TransportMessage {
    TransportMessage {
        id: MessageId::new(Sha256::digest(&bytes).to_vec()),
        payload: bytes,
        timestamp: Timestamp(0),
        causal_deps: vec![],
        source: TransportSource("interop".into()),
        envelope,
    }
}
#[async_trait]
impl TransportPeeler for RawPeeler {
    async fn peel_group_message(
        &self,
        m: &TransportMessage,
        _: &GroupContextSnapshot,
    ) -> Result<PeeledMessage, PeelerError> {
        Ok(PeeledMessage {
            id: m.id.clone(),
            group_id: None,
            sender: None,
            content: PeeledContent::MlsMessage {
                bytes: m.payload.clone(),
            },
            origin: m.clone(),
        })
    }
    async fn peel_welcome(&self, m: &TransportMessage) -> Result<PeeledMessage, PeelerError> {
        Ok(PeeledMessage {
            id: m.id.clone(),
            group_id: None,
            sender: None,
            content: PeeledContent::Welcome {
                created_at: None,
                bytes: m.payload.clone(),
            },
            origin: m.clone(),
        })
    }
    async fn wrap_group_message(
        &self,
        p: &EncryptedPayload,
        _: &GroupContextSnapshot,
    ) -> Result<TransportMessage, PeelerError> {
        Ok(message(
            p.ciphertext.clone(),
            TransportEnvelope::GroupMessage {
                transport_group_id: vec![],
            },
        ))
    }
    async fn wrap_welcome(
        &self,
        p: &EncryptedPayload,
        r: &MemberId,
    ) -> Result<TransportMessage, PeelerError> {
        Ok(message(
            p.ciphertext.clone(),
            TransportEnvelope::Welcome {
                recipient: r.clone(),
            },
        ))
    }
}
fn emit(v: Value) {
    println!("{}", v);
    io::stdout().flush().unwrap();
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let key = SigningKey::from_bytes(&[7; 32]).unwrap();
    let identity = key.verifying_key().to_bytes().to_vec();
    let mode = std::env::var("MDK_PROFILE").unwrap_or("app".into());
    let mut registry = cgka_engine::feature_registry::FeatureRegistry::new();
    if mode != "base" {
        use cgka_traits::capabilities::*;
        registry.register(
            Feature("self-remove"),
            CapabilityRequirement {
                requires: Capability::Proposal(10),
                level: RequirementLevel::Required,
                description: "self-remove",
            },
        );
    }
    let mut supported = vec![0x8001, 0x8003, 0x800c];
    if mode == "media" {
        supported.extend([0x8004, 0x800b]);
    }
    let mut engine = EngineBuilder::new(SqliteAccountStorage::in_memory().unwrap())
        .feature_registry(registry)
        .supported_app_components(supported)
        .identity(identity.clone())
        .account_identity_proof_signer(Arc::new(Signer(key)))
        .peeler(Box::new(RawPeeler))
        .build()
        .unwrap();
    let kp = engine.fresh_key_package().await.unwrap();
    emit(json!({"pubkey":hex::encode(&identity),"key_package":hex::encode(kp.bytes)}));
    for line in io::stdin().lock().lines() {
        let v: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let result = handle(&mut engine, &identity, &mode, v).await;
        emit(match result {
            Ok(v) => v,
            Err(e) => json!({"error":e}),
        });
    }
}

async fn handle(
    engine: &mut cgka_engine::Engine<SqliteAccountStorage>,
    identity: &[u8],
    mode: &str,
    v: Value,
) -> Result<Value, String> {
    match v["op"].as_str().unwrap() {
        "wrap" => {
            let keys = Keys::new(SecretKey::from_slice(&[7; 32]).unwrap());
            let rumor =
                UnsignedEvent::from_json(v["rumor"].to_string()).map_err(|e| e.to_string())?;
            let receiver =
                PublicKey::from_hex(v["recipient"].as_str().unwrap()).map_err(|e| e.to_string())?;
            let event = nostr::nips::nip59::GiftWrapBuilder::new(receiver, rumor)
                .finalize(&keys)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::from_str(&event.as_json()).unwrap())
        }
        "unwrap" => {
            let keys = Keys::new(SecretKey::from_slice(&[7; 32]).unwrap());
            let event = Event::from_json(v["event"].to_string()).map_err(|e| e.to_string())?;
            let gift = nostr::nips::nip59::UnwrappedGift::from_gift_wrap(&keys, &event)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::from_str(&gift.rumor.as_json()).unwrap())
        }

        #[cfg(feature = "media-probe")]
        "media_receive" => {
            use cgka_traits::engine::GroupEvent;
            let id = cgka_traits::types::GroupId::new(
                hex::decode(v["group_id"].as_str().unwrap()).unwrap(),
            );
            let transport_id = engine
                .group_context(&id)
                .map_err(|e| format!("{e:?}"))?
                .transport_group_id()
                .unwrap();
            let incoming = message(
                hex::decode(v["message"].as_str().unwrap()).unwrap(),
                TransportEnvelope::GroupMessage {
                    transport_group_id: transport_id,
                },
            );
            engine.drain_events();
            let disposition = engine
                .ingest(incoming)
                .await
                .map_err(|e| format!("{e:?}"))?;
            for event in engine.drain_events() {
                if let GroupEvent::MessageReceived {
                    payload,
                    epoch,
                    encrypted_media_secret: Some(secret),
                    ..
                } = event
                {
                    let rumor: Value =
                        serde_json::from_slice(&payload).map_err(|e| e.to_string())?;
                    let mut outcomes = vec![];
                    for tag in rumor["tags"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|tag| tag[0] == "imeta")
                    {
                        outcomes.push(
                            match marmot_app::marmot_ts_media_probe(
                                json!({"op":"download", "tag":tag}),
                                secret.as_bytes(),
                                epoch.0,
                            )
                            .await
                            {
                                Ok(mut value) => {
                                    value["status"] = json!("ready");
                                    value
                                }
                                Err(_) => json!({"status":"unavailable"}),
                            },
                        );
                    }
                    let mut result = outcomes.first().cloned().ok_or("no attachments")?;
                    result["caption"] = rumor["content"].clone();
                    result["outcomes"] = json!(outcomes);
                    return Ok(result);
                }
            }
            Err(format!("no authenticated media delivery: {disposition:?}"))
        }
        #[cfg(feature = "media-probe")]
        "advance" => {
            use cgka_traits::engine::SendIntent;
            let id = cgka_traits::types::GroupId::new(
                hex::decode(v["group_id"].as_str().unwrap()).unwrap(),
            );
            let result = engine
                .send(SendIntent::SelfUpdate { group_id: id })
                .await
                .map_err(|e| format!("{e:?}"))?;
            if let SendResult::GroupEvolution { msg, pending, .. } = result {
                engine
                    .confirm_published(pending)
                    .await
                    .map_err(|e| format!("{e:?}"))?;
                Ok(json!({"message":hex::encode(msg.payload)}))
            } else {
                Err(format!("unexpected update: {result:?}"))
            }
        }
        #[cfg(feature = "media-probe")]
        "media_fixture" => {
            let result = marmot_app::marmot_ts_media_probe(
                json!({"op":"media_upload", "server":v["server"]}),
                &[42; 32],
                7,
            )
            .await?;
            use cgka_traits::app_components::*;
            let policy = encode_encrypted_media_policy_v2(
                &EncryptedMediaPolicyV2::blossom_default(vec!["https://example.com/media".into()])
                    .unwrap(),
            )
            .unwrap();
            Ok(json!({"tag":result["tag"], "policy":hex::encode(policy)}))
        }
        #[cfg(feature = "media-probe")]
        "media_upload" => {
            use cgka_traits::engine::SendIntent;
            use cgka_traits::types::GroupId;
            let id = GroupId::new(hex::decode(v["group_id"].as_str().unwrap()).unwrap());
            let context = engine.group_context(&id).map_err(|e| format!("{e:?}"))?;
            let epoch = context.epoch();
            let secret = context
                .exporter_secret(
                    cgka_traits::app_components::GROUP_ENCRYPTED_MEDIA_EXPORTER_CACHE_KEY,
                    32,
                )
                .ok_or("media exporter missing")?;
            drop(context);
            let result = marmot_app::marmot_ts_media_probe(v, &secret, epoch.0).await?;
            let mut rumor = UnsignedEvent::from_json(
                json!({
                    "pubkey":hex::encode(identity), "kind":9, "created_at":1,
                    "content":"Rust caption", "tags":[result["tag"].clone()]
                })
                .to_string(),
            )
            .map_err(|e| e.to_string())?;
            rumor.ensure_id();
            let sent = engine
                .send(SendIntent::AppMessage {
                    group_id: id,
                    payload: rumor.as_json().into_bytes(),
                    expected_epoch: Some(epoch),
                })
                .await
                .map_err(|e| format!("{e:?}"))?;
            match sent {
                SendResult::ApplicationMessage { msg, .. } => {
                    Ok(json!({"message":hex::encode(msg.payload)}))
                }
                other => Err(format!("unexpected media send: {other:?}")),
            }
        }

        "create" => {
            let kp = KeyPackage::new(hex::decode(v["key_package"].as_str().unwrap()).unwrap())
                .with_protocol_profile(ProtocolProfile::Current);
            let (id, r) = engine
                .create_group(CreateGroupRequest {
                    name: "Rust interop".into(),
                    description: "".into(),
                    members: vec![kp],
                    required_features: vec![],
                    app_components: if mode == "media" {
                        use cgka_traits::app_components::*;
                        vec![
                            AppComponentData {
                                component_id: 0x8004,
                                data: encode_nostr_routing_v1(
                                    &NostrRoutingV1::new(
                                        [3; 32],
                                        vec!["wss://relay.example.com".into()],
                                    )
                                    .unwrap(),
                                )
                                .unwrap(),
                            },
                            AppComponentData {
                                component_id: 0x800b,
                                data: encode_encrypted_media_policy_v2(
                                    &EncryptedMediaPolicyV2::blossom_default(vec![
                                        v["server"].as_str().unwrap().into(),
                                    ])
                                    .unwrap(),
                                )
                                .unwrap(),
                            },
                        ]
                    } else {
                        vec![]
                    },
                    initial_admins: vec![],
                })
                .await
                .map_err(|e| format!("{e:?}"))?;
            let welcomes = match r {
                SendResult::FoundingGroupCreated { welcomes } => welcomes,
                other => return Err(format!("unexpected: {other:?}")),
            };
            Ok(
                json!({"group_id":hex::encode(id.as_slice()),"welcome":hex::encode(&welcomes[0].payload)}),
            )
        }
        "join" => {
            let m = message(
                hex::decode(v["welcome"].as_str().unwrap()).unwrap(),
                TransportEnvelope::Welcome {
                    recipient: MemberId::new(identity.to_vec()),
                },
            );
            let id = engine.join_welcome(m).await.map_err(|e| format!("{e:?}"))?;
            Ok(json!({"joined":format!("{id:?}")}))
        }
        _ => Err("unknown operation".into()),
    }
}
