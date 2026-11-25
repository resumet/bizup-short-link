'use client';
// 일반 HTML 폼 제출 버튼: 제출 중 표시·중복 제출 방지
import { useFormStatus } from 'react-dom';
import { useState, type ReactNode } from 'react';

export function SubmitButton({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();
  const [clicked, setClicked] = useState(false);
  const busy = pending || clicked;
  return (
    <button
      className="button"
      type="submit"
      style={{ minHeight: '2.75rem' }}
      aria-disabled={busy}
      onClick={(e) => {
        if (busy) { e.preventDefault(); return; }
        const form = e.currentTarget.form;
        // 브라우저 기본 검증을 통과할 때만 제출 중으로 표시
        if (form && form.checkValidity()) setClicked(true);
      }}
    >
      {busy && <span className="spinner" aria-hidden="true" />}{children}
    </button>
  );
}
