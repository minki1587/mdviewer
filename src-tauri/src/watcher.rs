//! 열려 있는 탭의 파일이 바깥에서 바뀌었는지 지켜본다.
//!
//! Electron 판은 `fs.watch` 를 썼지만, 여기서는 열린 파일 몇 개의
//! 수정 시각만 주기로 비교한다. 감시 대상이 많아야 탭 수만큼이라
//! 비용이 사실상 없고, 플랫폼별 이벤트 중복·누락을 신경 쓰지 않아도 된다.

use std::{
    collections::HashMap,
    path::PathBuf,
    time::{Duration, SystemTime},
};

pub const POLL: Duration = Duration::from_millis(700);

/// 우리가 저장한 직후에는 이 시간만큼 변경을 무시한다.
/// (저장 → 파일 변경 → "디스크에서 바뀌었습니다" 가 뜨는 것을 막는다)
const MUTE: Duration = Duration::from_millis(900);

type Stamp = (SystemTime, u64);

#[derive(Default)]
pub struct Watcher {
    /// 감시 대상과 마지막으로 본 (수정 시각, 크기)
    seen: HashMap<PathBuf, Option<Stamp>>,
    /// 이 시각 전까지는 변경을 무시한다
    muted: HashMap<PathBuf, SystemTime>,
}

fn stamp(path: &PathBuf) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

impl Watcher {
    /// 렌더러가 준 목록대로 감시 대상을 맞춘다.
    pub fn set_list(&mut self, paths: Vec<PathBuf>) {
        self.seen.retain(|p, _| paths.contains(p));
        for p in paths {
            let current = stamp(&p);
            self.seen.entry(p).or_insert(current);
        }
    }

    /// 방금 우리가 쓴 파일이라고 표시한다.
    pub fn mute(&mut self, path: &PathBuf) {
        self.muted.insert(path.clone(), SystemTime::now() + MUTE);
        // 우리가 쓴 내용은 기준선으로 삼는다
        if let Some(slot) = self.seen.get_mut(path) {
            *slot = stamp(path);
        }
    }

    /// 바뀐 파일 목록을 돌려주고 기준선을 갱신한다.
    pub fn changed(&mut self) -> Vec<PathBuf> {
        let now = SystemTime::now();
        self.muted.retain(|_, until| *until > now);

        let mut hits = Vec::new();
        for (path, last) in self.seen.iter_mut() {
            if self.muted.contains_key(path) {
                continue;
            }
            let current = stamp(path);
            // 파일이 잠깐 사라진 것(에디터의 원자적 저장)은 변경으로 보지 않는다
            if current.is_none() {
                continue;
            }
            if current != *last {
                *last = current;
                hits.push(path.clone());
            }
        }
        hits
    }
}
