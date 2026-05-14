from pathlib import Path
import os
import re
import winreg
import requests
from lxml import etree
import argparse
from colorama import Fore, Back, Style
from decimal import Decimal
import traceback
import subprocess
from shapely.geometry.polygon import Polygon

# For pdoc
__docformat__ = "google"

# START Constants
VATSYS_MAPS_PATH_RELATIVE = r'vatSys Files\Profiles\ATOP Oakland\Maps'
"""str: Standard path for the Maps folder of the ATOP Oakland profile inside a user's Documents folder."""

ISIGMET_API_URL = 'https://www.aviationweather.gov/cgi-bin/json/IsigmetJSON.php'
"""str: API URL to retrive GeoJSON SIGMETs."""

DEFAULT_FILENAME = 'SIGMET.XML'
"""str: Default output filename for the new map XML file."""

DEFAULT_MAP_ATTRIBUTES = {
    'Type'             : 'REST_NTZ_DAIW',
    'Name'             : 'SIGMETS',
    'Priority'         : '1',
    'CustomColourName' : 'PRDArea'
}
"""dict[str, str]: Dictionary defining default map attributes for the new SIGMETs map."""

DEFAULT_POLY_ATTRIBUTES = {
    'Type' : 'Line'
}
"""dict[str, str]: Dictionary defining default poly attributes for each SIGMET poly we draw."""

DEFAULT_LABEL_ATTRIBUTES = {
    'HasLeader' : 'false'
}
"""dict[str, str]: Dictionary defining default label attributes for each SIGMET label we draw."""
# END Constants

def error(error_message: str):
    """Writes styled error message to the console.

    Args:
        error_message: description of error
    """
    print(Fore.WHITE + Back.RED + 'ERROR:' + Style.RESET_ALL + ' ' + error_message)

def log(log_message: str):
    """Writes styled log message to the console.

    Args:
        error_message: description of logged action
    """
    print(Fore.WHITE + Back.GREEN + 'LOG:' + Style.RESET_ALL + ' ' + log_message)

def exit_with_wait():
    """ Prompts user to press enter key, then exits program
    """
    input('Press enter key to exit...')
    exit()

def convert_to_phonetic(word: str) -> str:
    """Converts a code word from the NATO phonetic alphabet into it's associated
    letter. Assumes that the given code word is a legitimate code word.

    Args:
        word: A code word that is part of the NATO phonetic alphabet.

    Returns:
        A single-character (alphabet letter) corresponding to code word.
    """
    
    return word[0].upper()


def find_vatsys_maps_dir() -> str | None:
    """Attempts to locate the Maps folder for the vatSys ATOP Oakland Profile.

    vatSys profiles are stored in a user's Documents folder. The method first
    tries to location the Documents folder via the Windows Registry. If that
    fails, it uses the default environment variable for a user's home. If that
    fails, the folder can not be automatically found.

    Returns:
        A string with the path to the Maps folder if found. None if not found.
    """
    # First we will try the registry method
    try:
        home_path = r'Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, home_path, access=winreg.KEY_READ)
        key_val, _ = winreg.QueryValueEx(key, 'Personal')
        winreg.CloseKey(key)
        full_dir = Path(key_val, VATSYS_MAPS_PATH_RELATIVE)
        if os.path.exists(full_dir):
            return full_dir
    except:
        pass

    # If we failed to find the folder via registry, try with Path method
    try:
        full_dir = Path(str(Path.home()), 'Documents', VATSYS_MAPS_PATH_RELATIVE)
        if os.path.exists(full_dir):
            return full_dir
    except:
        pass
    
    # If we are here, we haven't found anything, so return None
    return None

def find_vatsys_exec() -> str | None:
    """Attempts to locate the vatSys executable.

    Returns:
        A string with the path to the Maps folder if found. None if not found.
    """
    # Try the x86 folder first
    full_path = Path(os.environ['ProgramFiles(x86)'], 'vatSys', 'bin', 'vatSys.exe')
    if os.path.exists(full_path):
        return full_path

    # Next try the regular Program Files folder
    full_path = Path(os.environ['ProgramW6432'], 'vatSys', 'bin', 'vatSys.exe')
    if os.path.exists(full_path):
        return full_path
    
    # Return none if both fail
    return None

def filter_kzak_sigmets(geojson_dict: dict) -> list[dict]:
    """Returns only the GeoJSON features where `firId` equals `KZAK`.

    Args:
        geojson_dict: A GeoJSON root element represented as a dictionary.
    
    Returns:
        A list of GeoJSON features, where each is a dictionary.
    """
    return_list = []
    for feature in geojson_dict['features']:
        if 'firId' in feature['properties'] and feature['properties']['firId'] == 'KZAK':
            return_list.append(feature)

    return return_list

def make_base_map_xml(map_attributes: dict[str, str] = DEFAULT_MAP_ATTRIBUTES) -> tuple[etree.Element, etree.Element]:
    maps_root = etree.Element('Maps')
    map = etree.SubElement(maps_root, 'Map')

    for attribute, val in map_attributes.items():
        map.set(attribute, val)
    return (maps_root, map)

def coord_to_str(coord: float, int_length: int) -> str:
    d = Decimal(str(coord)) # conversion to avoid float precision isues?
    # API warns us we might get longitudes > 180, and to subtract 360 if we do
    integer_part = int(d) - 360 if int(d) > 180 else int(d)
    integer_part_str = str(integer_part).zfill(int_length)
    fractional_part = d % 1
    #vatSys apaprently doesn't like if we have fewer than 3 decimal places?
    fractional_part_str = f'{fractional_part:.3f}'.lstrip('0').lstrip('-0')
    leader = '+' if integer_part > 0 else ''
    return leader + integer_part_str + fractional_part_str

def long_to_str(coord: float) -> str:
    return coord_to_str(coord, 3)

def lat_to_str(coord: float) -> str:
    return coord_to_str(coord, 2)

def make_poly_xml(sigmet_poly: list[list[float]]) -> etree.Element:
    # Create the empty elements
    poly_element = etree.Element(DEFAULT_POLY_ATTRIBUTES['Type'])
    point_element = etree.SubElement(poly_element, 'Point')

    # Create all the point strings from the poly coords and add inside <Point> element
    point_strings = [lat_to_str(latitude) + long_to_str(longitude) for longitude, latitude in sigmet_poly]
    point_element.text = '/'.join(point_strings)
    log('created polygon with ISO 6709 coordinates %s' % point_strings)

    return poly_element

def make_label_xml(coords, series_id_str, label_attributes: dict[str, str] = DEFAULT_LABEL_ATTRIBUTES) -> etree.Element:
    # Create Label element
    label_element = etree.Element('Label')
    for attribute, val in label_attributes.items():
        label_element.set(attribute, val)
    
    # Convert seriesId string to shortened label text
    r = re.match(r'(\S+) ([0-9]+)', series_id_str)
    letter = convert_to_phonetic(r.group(1))
    number = r.group(2)
    label_name = 'SIG-%s%s' % (letter, number)

    # Calculate centroid and convert to ISO 6709
    centroid = Polygon(coords).centroid
    point_str = lat_to_str(centroid.y) + long_to_str(centroid.x)

    # Create Point child element with label text and inner coordinate for centroid
    point_element = etree.SubElement(label_element, 'Point')
    point_element.set('Name', label_name)
    point_element.text = point_str
    log('created label with ISO 6709 coordinates %s and label %s' % (point_str, label_name))

    return label_element

def run(vatsys_maps_dir: str, output_filename: str):
    """Main execution function for the script. Fetches SIGMETs from APIs, calls functions to
    parse data and form XML, and writes output.

    Args:
        vatsys_maps_dir: Path to the Maps folder of the vatSys ATOP Oakland profile.
        output_filname: Desired filename of the output XML file which will be saved in
            the Maps folder of the vatSys ATOP Oakland profile.
    """
    log('running with output location %s' % Path(vatsys_maps_dir, output_filename))
    
    # Fetch SIGMETs from API
    try:
        r = requests.get(ISIGMET_API_URL)
        sigmets_json = r.json()
        log('fetched JSON from %s' % ISIGMET_API_URL)
    except Exception as e:
        error('could not fetch SIGMETs from API')
        traceback.print_exc()
        exit_with_wait()

    # Make the XML
    try:
        # Make the base <Maps> and <Map> element
        maps_root, map_element = make_base_map_xml()
        # Iterate over each KZAK GeoJSON feature and make the Poly xml (<Infill> or <Line>). Add to <Map>
        filtered = filter_kzak_sigmets(sigmets_json)
        log('found %d SIGMETs for KZAK' % len(filtered))
        for geojson_sigmet in filtered:
            for poly_coords in geojson_sigmet['geometry']['coordinates']:
                poly_xml = make_poly_xml(poly_coords)
                label_xml = make_label_xml(poly_coords, geojson_sigmet['properties']['seriesId'])
                map_element.append(poly_xml)
                map_element.append(label_xml)
    except Exception:
        error('could not form XML')
        traceback.print_exc()
        exit_with_wait()
    
    # Write output XML
    try:
        path = Path(vatsys_maps_dir, output_filename)
        etree.ElementTree(maps_root).write(path, pretty_print=True)
        log('wrote XML file to %s' % path)
    except:
        error('could not write output file to %s' % path)
        traceback.print_exc()
        exit_with_wait()


if __name__ == '__main__':

    ## Creating the argument parser
    ## TODO: add options for verbosity? or to launch vatSys after? need to implement color option
    parser = argparse.ArgumentParser()
    parser.add_argument('--mapsdir', help="location of vatSys Maps folder for ATOP Oakland profile")
    parser.add_argument('--filename', help="full name of output XML file (including .xml)")
    parser.add_argument('--exec', help="location of vatSys executable")
    parser.add_argument('--color', help="name of vatSys color (from Colours.xml) to use for SIGMETs")
    args = parser.parse_args()

    # Get profile maps dir from command line first, or do auto. Fail out if we can't find
    maps_dir = args.mapsdir if args.mapsdir is not None else find_vatsys_maps_dir()
    if maps_dir is None:
        error('could not find suitable vatSys Maps folder for ATOP Oakland profile')
        exit_with_wait()
    
    # Get output filename for command line first, or just default
    filename = args.filename if args.filename is not None else DEFAULT_FILENAME

    # We've got the maps_dir and filename now, so we can run
    run(maps_dir, filename)
    
    # Get the vatSys executable to run after
    exec_path = args.exec if args.exec is not None else find_vatsys_exec()
    if exec_path is None:
        error('could not find suitable vatSys executable')
        exit_with_wait()
    else:
        log('opening vatSys executable at %s' % exec_path)
        subprocess.Popen([exec_path])
        exit_with_wait()
