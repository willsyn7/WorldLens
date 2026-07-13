from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable
from typing import ClassVar as _ClassVar, Optional as _Optional

DESCRIPTOR: _descriptor.FileDescriptor

class IndicatorRequest(_message.Message):
    __slots__ = ("country_code", "indicator_codes", "start_year", "end_year")
    COUNTRY_CODE_FIELD_NUMBER: _ClassVar[int]
    INDICATOR_CODES_FIELD_NUMBER: _ClassVar[int]
    START_YEAR_FIELD_NUMBER: _ClassVar[int]
    END_YEAR_FIELD_NUMBER: _ClassVar[int]
    country_code: str
    indicator_codes: _containers.RepeatedScalarFieldContainer[str]
    start_year: int
    end_year: int
    def __init__(self, country_code: _Optional[str] = ..., indicator_codes: _Optional[_Iterable[str]] = ..., start_year: _Optional[int] = ..., end_year: _Optional[int] = ...) -> None: ...

class IndicatorDataPoint(_message.Message):
    __slots__ = ("country_code", "country_name", "indicator_code", "indicator_name", "year", "value", "has_value")
    COUNTRY_CODE_FIELD_NUMBER: _ClassVar[int]
    COUNTRY_NAME_FIELD_NUMBER: _ClassVar[int]
    INDICATOR_CODE_FIELD_NUMBER: _ClassVar[int]
    INDICATOR_NAME_FIELD_NUMBER: _ClassVar[int]
    YEAR_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    HAS_VALUE_FIELD_NUMBER: _ClassVar[int]
    country_code: str
    country_name: str
    indicator_code: str
    indicator_name: str
    year: int
    value: float
    has_value: bool
    def __init__(self, country_code: _Optional[str] = ..., country_name: _Optional[str] = ..., indicator_code: _Optional[str] = ..., indicator_name: _Optional[str] = ..., year: _Optional[int] = ..., value: _Optional[float] = ..., has_value: _Optional[bool] = ...) -> None: ...
