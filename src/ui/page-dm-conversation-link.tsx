interface PageDmConversationLinkProps {
  kind: 'proposal' | 'send';
  rowId: string;
}

export function PageDmConversationLink({ kind, rowId }: PageDmConversationLinkProps) {
  return (
    <a
      className="page-dm-open-link secondary-button"
      href={`/api/facebook-page-dm-link/${kind}/${encodeURIComponent(rowId)}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      Open Facebook conversation
    </a>
  );
}
