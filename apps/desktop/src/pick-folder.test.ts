import { describe, expect, it } from 'vitest';
import { canPickFolder } from './pick-folder';

describe('canPickFolder', () => {
  it('스튜디오 화면 자신이 이 PC 주소에서 부르면 허용한다', () => {
    expect(canPickFolder({ senderId: 7, senderUrl: 'http://127.0.0.1:3000/sessions/abc', contentId: 7 })).toBe(true);
    expect(canPickFolder({ senderId: 7, senderUrl: 'http://localhost:3100/', contentId: 7 })).toBe(true);
  });

  it('스튜디오 화면이 아직 없으면(콘텐츠 뷰 미지정) 거부한다', () => {
    expect(canPickFolder({ senderId: 7, senderUrl: 'http://127.0.0.1:3000/', contentId: undefined })).toBe(false);
  });

  it('스튜디오 화면이 아닌 다른 뷰(도구 막대·로딩)가 부르면 거부한다', () => {
    expect(canPickFolder({ senderId: 3, senderUrl: 'http://127.0.0.1:3000/', contentId: 7 })).toBe(false);
  });

  it('스튜디오 화면이라도 외부 주소로 옮겨 갔으면 거부한다', () => {
    expect(canPickFolder({ senderId: 7, senderUrl: 'https://example.com/', contentId: 7 })).toBe(false);
  });

  it('주소를 알아볼 수 없으면 거부한다', () => {
    expect(canPickFolder({ senderId: 7, senderUrl: 'not a url', contentId: 7 })).toBe(false);
  });
});
