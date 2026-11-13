/** Header label: the column name with its type underneath. Plugged into AG Grid's default header via innerHeaderComponent. */
export function ColumnLabel({ displayName, typeText }: { displayName: string; typeText?: string }) {
  return (
    <span className="qw-colhead">
      <span className="qw-colname">{displayName}</span>
      {typeText && <span className="qw-coltype">{typeText}</span>}
    </span>
  )
}
