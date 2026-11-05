"""Windows PyInstaller and source entry. Imports follow freeze_support."""
import multiprocessing
import sys

if __name__ == '__main__':
    multiprocessing.freeze_support()
    from cadcleaner.cli import main
    sys.exit(main())
