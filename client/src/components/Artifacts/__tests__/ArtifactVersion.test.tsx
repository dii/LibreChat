import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ArtifactVersion from '../ArtifactVersion';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string =>
      key,
}));

describe('ArtifactVersion', () => {
  it('renders nothing when there is a single version', () => {
    const { container } = render(
      <ArtifactVersion currentIndex={0} totalVersions={1} onVersionChange={jest.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('disables the previous control on the first version', () => {
    render(<ArtifactVersion currentIndex={0} totalVersions={3} onVersionChange={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'com_ui_previous_version' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'com_ui_next_version' })).toBeEnabled();
  });

  it('disables the next control on the last version', () => {
    render(<ArtifactVersion currentIndex={2} totalVersions={3} onVersionChange={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'com_ui_next_version' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'com_ui_previous_version' })).toBeEnabled();
  });

  it('steps to the previous and next version indices within the group', () => {
    const onVersionChange = jest.fn();
    render(
      <ArtifactVersion currentIndex={1} totalVersions={3} onVersionChange={onVersionChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_previous_version' }));
    expect(onVersionChange).toHaveBeenCalledWith(0);

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_next_version' }));
    expect(onVersionChange).toHaveBeenCalledWith(2);
  });
});
