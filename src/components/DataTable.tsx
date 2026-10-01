import { useState, type ReactNode } from 'react'
import {
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  columnFilteringFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import { cx, Input, Select } from './ui'

export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, datetime: sortFn_datetime },
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: { includesString: filterFn_includesString },
})

export type DataTableFeatures = typeof dataTableFeatures

export function dataColumnHelper<TData extends object>() {
  return createColumnHelper<DataTableFeatures, TData>()
}

/** Spaltenüberschrift als Text, für die Kartenansicht und das Sortiermenü. */
function headerText(column: { id: string; columnDef: { header?: unknown } }) {
  return typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id
}

export function DataTable<TData extends object>({
  data,
  columns,
  initialSorting = [],
  searchPlaceholder,
  emptyText = 'Keine Einträge vorhanden.',
  onRowClick,
  toolbar,
  sorting,
  onSortingChange,
  footer,
}: {
  data: TData[]
  columns: ColumnDef<DataTableFeatures, TData, any>[]
  initialSorting?: SortingState
  /** Wenn gesetzt, wird eine clientseitige Volltextsuche angezeigt. */
  searchPlaceholder?: string
  emptyText?: string
  onRowClick?: (row: TData) => void
  toolbar?: ReactNode
  /** Serverseitige Sortierung: Zustand kommt von außen, die Zeilen werden nicht umsortiert. */
  sorting?: SortingState
  onSortingChange?: (sorting: SortingState) => void
  footer?: ReactNode
}) {
  const [globalFilter, setGlobalFilter] = useState('')
  const table = useTable({
    features: dataTableFeatures,
    data,
    columns,
    initialState: { sorting: initialSorting },
    state: sorting ? { globalFilter, sorting } : { globalFilter },
    manualSorting: !!sorting,
    onSortingChange: onSortingChange
      ? (updater) => onSortingChange(typeof updater === 'function' ? updater(sorting ?? []) : updater)
      : undefined,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: 'includesString',
  })

  const rows = table.getRowModel().rows
  const sortable = table.getAllLeafColumns().filter((c) => c.getCanSort())
  const sortedColumn = sortable.find((c) => c.getIsSorted())
  const currentSort = sortedColumn ? { id: sortedColumn.id, desc: sortedColumn.getIsSorted() === 'desc' } : undefined

  return (
    <div className="space-y-3">
      {searchPlaceholder || toolbar ? (
        <div className="flex flex-wrap items-center gap-2">
          {searchPlaceholder ? (
            <Input
              type="search"
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder={searchPlaceholder}
              className="max-w-xs"
            />
          ) : null}
          {toolbar}
        </div>
      ) : null}
      {/* Auf schmalen Bildschirmen Karten statt Tabelle, damit nichts quer scrollt (Issue #20). */}
      <div className="space-y-2 sm:hidden">
        {sortable.length ? (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            Sortieren nach
            <Select
              value={currentSort ? `${currentSort.id}:${currentSort.desc ? 'desc' : 'asc'}` : ''}
              onChange={(e) => {
                const [id, dir] = e.target.value.split(':')
                const next: SortingState = id ? [{ id, desc: dir === 'desc' }] : []
                if (onSortingChange) onSortingChange(next)
                else table.setSorting(next)
              }}
              className="flex-1"
            >
              {currentSort ? null : <option value="">Standard</option>}
              {sortable.flatMap((c) => [
                <option key={`${c.id}:asc`} value={`${c.id}:asc`}>
                  {headerText(c)} aufsteigend
                </option>,
                <option key={`${c.id}:desc`} value={`${c.id}:desc`}>
                  {headerText(c)} absteigend
                </option>,
              ])}
            </Select>
          </label>
        ) : null}
        {rows.length === 0 ? (
          <p className="rounded-lg bg-white px-3 py-8 text-center text-sm text-slate-500 ring-1 ring-slate-200">{emptyText}</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                className={cx('rounded-lg bg-white p-3 text-sm shadow-sm ring-1 ring-slate-200', onRowClick && 'cursor-pointer')}
              >
                <dl className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1">
                  {row.getAllCells().map((cell) => (
                    <div key={cell.id} className="contents">
                      <dt className="text-slate-600">{headerText(cell.column)}</dt>
                      <dd className="min-w-0 break-words">
                        <table.FlexRender cell={cell} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="hidden overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-slate-200 sm:block">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted()
                  const canSort = header.column.getCanSort()
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                      className="px-3 py-2 text-left font-medium whitespace-nowrap text-slate-600"
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="inline-flex items-center gap-1 hover:text-slate-900"
                        >
                          <table.FlexRender header={header} />
                          <span aria-hidden className="text-xs text-slate-400">
                            {sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '↕'}
                          </span>
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={table.getAllLeafColumns().length} className="px-3 py-8 text-center text-slate-500">
                  {emptyText}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  className={cx(onRowClick && 'cursor-pointer hover:bg-slate-50')}
                >
                  {row.getAllCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2 align-top">
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  )
}
